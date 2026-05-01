#!/bin/bash
# ============================================================================
# BACKUP AUTOMATION — SQLite + Redis
# Run as cron: 0 3 * * * /home/deploy/dev-panel/infra/backup-cron.sh
# ============================================================================

set -euo pipefail

BACKUP_DIR="/home/deploy/backups"
RETENTION_DAYS=7
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# ============================================================================
# 1. Backup SQLite databases
# ============================================================================
echo "[$(date)] Starting SQLite backup..."

if [ -d "/home/deploy/dev-panel/storage" ]; then
  tar -czf "$BACKUP_DIR/devpanel-storage-$TIMESTAMP.tar.gz" \
    -C /home/deploy/dev-panel storage/

  echo "[$(date)] ✓ SQLite backup: devpanel-storage-$TIMESTAMP.tar.gz"
else
  echo "[$(date)] ⚠️  Storage directory not found"
fi

# ============================================================================
# 2. Backup Redis
# ============================================================================
echo "[$(date)] Starting Redis backup..."

docker exec devpanel-redis redis-cli BGSAVE

# Wait for BGSAVE to complete
while [ "$(docker exec devpanel-redis redis-cli LASTSAVE)" == "$(docker exec devpanel-redis redis-cli LASTSAVE)" ]; do
  sleep 1
done

# Copy RDB file
docker cp devpanel-redis:/data/dump.rdb "$BACKUP_DIR/redis-$TIMESTAMP.rdb"

echo "[$(date)] ✓ Redis backup: redis-$TIMESTAMP.rdb"

# ============================================================================
# 2b. Backup GlitchTip Postgres (DEVPA-168)
# Container is in profile `glitchtip` and may not be running on every host.
# Soft-skip if it's down — backups must never fail the whole run because
# one optional service is offline. NB: Plane / Affine / Penpot Postgres
# volumes are NOT backed up here yet — tracked separately, out of scope
# for DEVPA-168.
# ============================================================================
if docker ps --format '{{.Names}}' | grep -q '^glitchtip-db$'; then
  echo "[$(date)] Starting GlitchTip Postgres backup..."
  if docker exec glitchtip-db pg_dump -U glitchtip -d glitchtip 2>/dev/null \
       | gzip > "$BACKUP_DIR/glitchtip-pg-$TIMESTAMP.sql.gz"; then
    echo "[$(date)] ✓ GlitchTip PG backup: glitchtip-pg-$TIMESTAMP.sql.gz"
  else
    echo "[$(date)] ⚠️  GlitchTip pg_dump failed — leaving partial file"
  fi
else
  echo "[$(date)] ℹ️  glitchtip-db not running, skipping pg_dump"
fi

# ============================================================================
# 3. Clean old backups
# ============================================================================
echo "[$(date)] Cleaning backups older than $RETENTION_DAYS days..."

find "$BACKUP_DIR" -name "devpanel-storage-*.tar.gz" -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name "redis-*.rdb" -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name "glitchtip-pg-*.sql.gz" -mtime +$RETENTION_DAYS -delete

echo "[$(date)] ✓ Cleanup complete"

# ============================================================================
# 4. Upload to S3 (optional)
# ============================================================================
if [ -n "${AWS_S3_BACKUP_BUCKET:-}" ]; then
  echo "[$(date)] Uploading to S3..."

  aws s3 cp "$BACKUP_DIR/devpanel-storage-$TIMESTAMP.tar.gz" \
    "s3://$AWS_S3_BACKUP_BUCKET/devpanel/storage-$TIMESTAMP.tar.gz"

  aws s3 cp "$BACKUP_DIR/redis-$TIMESTAMP.rdb" \
    "s3://$AWS_S3_BACKUP_BUCKET/devpanel/redis-$TIMESTAMP.rdb"

  if [ -f "$BACKUP_DIR/glitchtip-pg-$TIMESTAMP.sql.gz" ]; then
    aws s3 cp "$BACKUP_DIR/glitchtip-pg-$TIMESTAMP.sql.gz" \
      "s3://$AWS_S3_BACKUP_BUCKET/devpanel/glitchtip-pg-$TIMESTAMP.sql.gz"
  fi

  echo "[$(date)] ✓ S3 upload complete"
fi

# ============================================================================
# 5. Send notification
# ============================================================================
if [ -n "${SHELLY_TELEGRAM_WEBHOOK:-}" ]; then
  curl -X POST "$SHELLY_TELEGRAM_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "{
      \"text\": \"✅ DevPanel backup completed\n\n• SQLite: devpanel-storage-$TIMESTAMP.tar.gz\n• Redis: redis-$TIMESTAMP.rdb\n• Time: $(date)\",
      \"parse_mode\": \"Markdown\"
    }" || true
fi

echo "[$(date)] ✅ Backup complete"
