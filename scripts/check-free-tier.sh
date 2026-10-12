#!/usr/bin/env bash
# Free-tier budget check for the Oracle Always Free VM (2 OCPU / 12 GB).
#
# Exists so approaching a limit is noticed before Oracle starts charging or
# before the VM becomes unusable — the two failure modes that turn a $0 bill
# into a surprise.
set -uo pipefail

CPU_LIMIT=${CPU_LIMIT:-2}
MEM_LIMIT_MB=${MEM_LIMIT_MB:-12288}     # 12 GB
DISK_WARN_PCT=${DISK_WARN_PCT:-75}
VOL_WARN_PCT=${VOL_WARN_PCT:-75}

status=0
warn() { echo "  WARN  $*"; status=1; }
ok()   { echo "  ok    $*"; }

echo "SellerCtrl free-tier budget check — $(date -u '+%Y-%m-%d %H:%M UTC')"
echo

echo "Host"
CPU_ONLINE=$(nproc)
MEM_TOTAL_MB=$(( $(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo) ))
printf '  CPUs: %s (Always Free ARM ceiling %s)\n' "$CPU_ONLINE" "$CPU_LIMIT"
printf '  RAM : %s MB (Always Free ceiling %s MB)\n' "$MEM_TOTAL_MB" "$MEM_LIMIT_MB"
[ "$CPU_ONLINE" -gt "$CPU_LIMIT" ] && warn "more vCPUs than the free tier allows — this VM may be billable"
[ "$MEM_TOTAL_MB" -gt "$MEM_LIMIT_MB" ] && warn "more RAM than the free tier allows — this VM may be billable"
[ "$CPU_ONLINE" -le "$CPU_LIMIT" ] && ok "CPU within free allowance"
[ "$MEM_TOTAL_MB" -le "$MEM_LIMIT_MB" ] && ok "memory within free allowance"

echo
echo "Disk (root)"
DISK_PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
printf '  root %s%% used\n' "$DISK_PCT"
[ "$DISK_PCT" -ge "$DISK_WARN_PCT" ] && warn "root disk at ${DISK_PCT}% — prune images or raise the volume" || ok "root disk healthy"

echo
echo "Containers"
if command -v docker >/dev/null 2>&1; then
  docker compose ps --format '{{.Name}}\t{{.Status}}\t{{.Memory}}' 2>/dev/null | while IFS=$'\t' read -r name status mem; do
    [ -n "$name" ] && echo "  $name  $status  mem=$mem"
  done
  RUNNING=$(docker ps --filter 'name=sellerctrl-worker' --format '{{.Names}}' | wc -l)
  [ "$RUNNING" -gt 1 ] && echo "  WARN  $RUNNING worker replicas — a second replica would be idle, and if it were not for the app lock it would double the request rate" || ok "exactly one worker"
  WORKER_MEM=$(docker stats --no-stream --format '{{.MemUsage}}' sellerctrl-worker 2>/dev/null | head -1)
  [ -n "$WORKER_MEM" ] && echo "  worker memory in use: $WORKER_MEM (limit 6 GB)"
else
  echo "  docker not found — run inside the VM"
fi

echo
echo "Data volumes"
for v in sellerctrl_pgdata sellerctrl_apidata; do
  POINT=$(docker volume inspect "$v" --format '{{.Mountpoint}}' 2>/dev/null)
  if [ -n "$POINT" ] && [ -d "$POINT" ]; then
    PCT=$(df --output=pcent "$POINT" | tail -1 | tr -dc '0-9')
    printf '  %-24s %s%% used\n' "$v" "$PCT"
    [ "$PCT" -ge "$VOL_WARN_PCT" ] && warn "$v at ${PCT}%"
  else
    echo "  $v  (not present)"
  fi
done

echo
[ $status -eq 0 ] && echo "Within free-tier limits." || echo "Review the warnings above."
exit $status
