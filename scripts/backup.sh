#!/usr/bin/env bash
# Backup PostgreSQL and the report volume, inside the free-tier budget.
#
# Keeps one week of daily dumps plus one weekly dump. That is deliberate: an
# unbounded retention policy on a small always-free volume is a slow way to run
# out of disk, and a backup nobody prunes is not a backup.
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/srv/sellerctrl-backups}
KEEP_DAILY=${KEEP_DAILY:-7}
KEEP_WEEKLY=${KEEP_WEEKLY:-4}

mkdir -p "$BACKUP_DIR"/daily "$BACKUP_DIR"/weekly
STAMP=$(date -u '+%Y%m%d-%H%M%S')

echo "[backup] dumping PostgreSQL"
# --clean so a restore cannot hit existing objects.
docker compose exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-sellerctrl}" -d "${POSTGRES_DB:-sellerctrl}" --clean --if-exists \
  | gzip -9 > "$BACKUP_DIR/daily/db-$STAMP.sql.gz"

echo "[backup] reports"
docker run --rm \
  -v sellerctrl_apidata:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine:3 tar czf /backup/daily/reports-$STAMP.tar.gz -C /data reports 2>/dev/null || \
  echo "[backup] no report directory yet (nothing scraped) — skipped"

# Sunday snapshot kept longer.
if [ "$(date -u '+%u')" = "7" ]; then
  cp "$BACKUP_DIR"/daily/db-*.sql.gz "$BACKUP_DIR/weekly/" 2>/dev/null || true
fi

echo "[backup] pruning to $KEEP_DAILY daily / $KEEP_WEEKLY weekly"
ls -1t "$BACKUP_DIR"/daily/db-*.sql.gz 2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | xargs -r rm -f
ls -1t "$BACKUP_DIR"/daily/reports-*.tar.gz 2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | xargs -r rm -f
ls -1t "$BACKUP_DIR"/weekly/*.sql.gz 2>/dev/null | tail -n +$((KEEP_WEEKLY + 1)) | xargs -r rm -f

echo "[backup] done:"
du -sh "$BACKUP_DIR"/daily "$BACKUP_DIR"/weekly 2>/dev/null || true

cat <<'RESTORE'

To restore:
  gunzip -c db-YYYYMMDD-HHMMSS.sql.gz | docker compose exec -T postgres psql -U sellerctrl -d sellerctrl
RESTORE
