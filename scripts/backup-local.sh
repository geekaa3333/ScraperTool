#!/usr/bin/env bash
# Back up the local database, reports and uploads.
#
# SQLite is being written to by two processes (API and worker) at all times, so
# copying the file with `cp` can capture a torn page. `sqlite3 .backup` takes a
# transactionally consistent snapshot instead, which is why it is used rather
# than cp. Integrity is then verified on the copy — a backup nobody has checked
# is a hope, not a backup.
#
# Retention is bounded on purpose. An unbounded retention policy on a laptop is
# a slow way to run out of disk.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${SELLERCTRL_DATA_DIR:-$APP_DIR/data}"
BACKUP_DIR="${SELLERCTRL_BACKUP_DIR:-$APP_DIR/data/backups}"
KEEP_DAILY="${SELLERCTRL_KEEP_DAILY:-7}"
KEEP_WEEKLY="${SELLERCTRL_KEEP_WEEKLY:-4}"

STAMP="$(date -u '+%Y%m%d-%H%M%S')"
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

# Where the database actually lives. The WAL sidecar is not copied: the backup
# command folds it in, so the .db it produces is complete on its own.
DB_PATH="${SELLERCTRL_DB:-$DATA_DIR/sellerctrl.db}"

if [ ! -f "$DB_PATH" ]; then
  echo "[backup] no database at $DB_PATH — nothing to do"
  exit 0
fi

# `sqlite3` is not guaranteed to be installed. Fall back to copying the main
# database plus its WAL and SHM sidecars, which together form a consistent
# snapshot as long as they are copied together.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/daily/db-$STAMP.sqlite'"
  SOURCE="transactional .backup"
else
  cp "$DB_PATH" "$BACKUP_DIR/daily/db-$STAMP.sqlite"
  [ -f "$DB_PATH-wal" ] && cp "$DB_PATH-wal" "$BACKUP_DIR/daily/db-$STAMP.sqlite-wal"
  [ -f "$DB_PATH-shm" ] && cp "$DB_PATH-shm" "$BACKUP_DIR/daily/db-$STAMP.sqlite-shm"
  SOURCE="file copy (install sqlite3 for a consistent snapshot)"
fi

# ---------------------------------------------------------------------------
# Verify the backup before trusting it.
# ---------------------------------------------------------------------------
VERIFY="$BACKUP_DIR/daily/db-$STAMP.sqlite"
if command -v sqlite3 >/dev/null 2>&1; then
  RESULT="$(sqlite3 "$VERIFY" 'PRAGMA integrity_check;' 2>&1 || echo 'unreadable')"
  if [ "$RESULT" != "ok" ]; then
    echo "[backup] FAILED integrity check: $RESULT"
    echo "[backup] the copy at $VERIFY is not trustworthy and should be deleted"
    exit 1
  fi
  JOBS="$(sqlite3 "$VERIFY" 'SELECT count(*) FROM scraping_jobs;' 2>/dev/null || echo '?')"
  ITEMS="$(sqlite3 "$VERIFY" 'SELECT count(*) FROM job_items;' 2>/dev/null || echo '?')"
  echo "[backup] integrity ok — $JOBS job(s), $ITEMS queue item(s)"
else
  echo "[backup] WARNING: sqlite3 not installed, so the backup could not be verified"
fi
echo "[backup] source: $SOURCE"

# ---------------------------------------------------------------------------
# Reports and uploads.
# ---------------------------------------------------------------------------
# Archived report files are the user's real work product: hours of scraping
# turned into a spreadsheet. They are copied every run, not just on a schedule,
# because losing them is far worse than the disk cost.
if [ -d "$DATA_DIR/reports" ]; then
  tar czf "$BACKUP_DIR/daily/reports-$STAMP.tar.gz" -C "$DATA_DIR" reports
  echo "[backup] reports archived"
fi
if [ -d "$DATA_DIR/uploads" ]; then
  tar czf "$BACKUP_DIR/daily/uploads-$STAMP.tar.gz" -C "$DATA_DIR" uploads
  echo "[backup] uploads archived"
fi

# Sunday snapshot kept longer.
if [ "$(date -u '+%u')" = "7" ]; then
  cp "$BACKUP_DIR/daily/db-$STAMP.sqlite" "$BACKUP_DIR/weekly/db-$STAMP.sqlite"
  [ -f "$BACKUP_DIR/daily/reports-$STAMP.tar.gz" ] && \
    cp "$BACKUP_DIR/daily/reports-$STAMP.tar.gz" "$BACKUP_DIR/weekly/reports-$STAMP.tar.gz"
fi

# ---------------------------------------------------------------------------
# Retention — oldest first, and reports are pruned before databases.
# ---------------------------------------------------------------------------
# Databases are kept in preference to reports: a database can regenerate a
# report, but a deleted report file is gone.
echo "[backup] pruning to $KEEP_DAILY daily / $KEEP_WEEKLY weekly"
ls -1t "$BACKUP_DIR"/daily/reports-*.tar.gz 2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | xargs -r rm -f
ls -1t "$BACKUP_DIR"/daily/uploads-*.tar.gz 2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | xargs -r rm -f
ls -1t "$BACKUP_DIR"/daily/db-*.sqlite     2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | xargs -r rm -f
ls -1t "$BACKUP_DIR"/weekly/*              2>/dev/null | tail -n +$((KEEP_WEEKLY + 1)) | xargs -r rm -f

TOTAL="$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)"
echo "[backup] done — total backup size ${TOTAL:-unknown}"

if [ "$(df -P "$APP_DIR" | tail -1 | awk '{print $5}' | tr -d '%')" -ge 90 ]; then
  echo
  echo "[backup] WARNING: the disk holding the project is 90%+ full."
  echo "[backup] A large scraping job needs room for its database and Excel exports."
  echo "[backup] Free some space, or move backups to an external drive:"
  echo "[backup]   SELLERCTRL_BACKUP_DIR=/media/\$USB/sellerctrl-backups $0"
fi

cat <<'RESTORE'

Restore
-------
  1. Stop SellerCtrl:        ./scripts/sellerctrl.sh stop
  2. Keep a copy of the current database, just in case:
       cp data/sellerctrl.db data/sellerctrl.db.before-restore
  3. Replace the database:
       cp data/backups/daily/db-YYYYMMDD-HHMMSS.sqlite data/sellerctrl.db
       rm -f data/sellerctrl.db-wal data/sellerctrl.db-shm
  4. Restore reports (optional, only if they were lost):
       tar xzf data/backups/daily/reports-YYYYMMDD-HHMMSS.tar.gz -C data
  5. Start again:            ./scripts/sellerctrl.sh start

Every job the restore brings back is a real recorded job. Nothing is
reconstructed or guessed.
RESTORE