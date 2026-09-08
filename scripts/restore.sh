#!/usr/bin/env sh
# =============================================================================
# Invenzo — PostgreSQL restore script
#
# POSIX sh — compatible with Alpine Linux's /bin/sh (ash/busybox).
# ALWAYS restore into an isolated test database first — never run against
# the live production database without a reviewed maintenance plan.
#
# Usage:
#   sh /restore.sh /path/to/backup.dump
#   sh /restore.sh /backups/latest.dump
#
# Environment variables:
#   PGHOST        PostgreSQL host       (default: postgres)
#   PGPORT        PostgreSQL port       (default: 5432)
#   PGDATABASE    Target database name  (REQUIRED — no default to prevent accidents)
#   PGUSER        Database user         (falls back to POSTGRES_USER)
#   PGPASSWORD    Database password     (falls back to POSTGRES_PASSWORD)
# =============================================================================
set -eu

DUMP_FILE="${1:-}"

if [ -z "${DUMP_FILE}" ]; then
    echo "Usage: $0 <dump_file>" >&2
    exit 1
fi

if [ ! -f "${DUMP_FILE}" ]; then
    echo "[restore] ERROR: dump file not found: ${DUMP_FILE}" >&2
    exit 1
fi

PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-}"
PGUSER="${PGUSER:-${POSTGRES_USER:-postgres}}"
PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"

export PGPASSWORD

# Cleanup for any temporary decrypted file (removed on exit, even on error).
DECRYPTED_TMP=""
cleanup() {
    if [ -n "${DECRYPTED_TMP}" ] && [ -f "${DECRYPTED_TMP}" ]; then
        rm -f "${DECRYPTED_TMP}"
    fi
}
trap cleanup EXIT INT TERM

if [ -z "${PGDATABASE}" ]; then
    echo "[restore] ERROR: PGDATABASE must be set explicitly — refusing to guess to prevent accidental production overwrite" >&2
    exit 1
fi

if [ -z "${PGPASSWORD}" ]; then
    echo "[restore] ERROR: PGPASSWORD / POSTGRES_PASSWORD is not set" >&2
    exit 1
fi

# ---- Verify checksum ---------------------------------------------------------
# Resolve symlinks so we find the checksum for the real file
# (e.g. latest.dump → invenzo-2026-01-01T02-00-00.dump whose .sha256 exists)
REAL_DUMP_FILE="${DUMP_FILE}"
if [ -L "${DUMP_FILE}" ]; then
    REAL_DUMP_FILE="$(readlink -f "${DUMP_FILE}" 2>/dev/null || readlink "${DUMP_FILE}")"
fi
CHECKSUM_FILE="${REAL_DUMP_FILE}.sha256"

if [ -f "${CHECKSUM_FILE}" ]; then
    echo "[restore] Verifying checksum..."
    if command -v sha256sum >/dev/null 2>&1; then
        if ! sha256sum -c "${CHECKSUM_FILE}"; then
            echo "[restore] ERROR: checksum verification failed — backup file may be corrupt" >&2
            exit 2
        fi
    elif command -v shasum >/dev/null 2>&1; then
        if ! shasum -a 256 -c "${CHECKSUM_FILE}"; then
            echo "[restore] ERROR: checksum verification failed — backup file may be corrupt" >&2
            exit 2
        fi
    else
        echo "[restore] WARNING: no sha256sum or shasum found — skipping checksum verification"
    fi
    echo "[restore] Checksum OK"
else
    echo "[restore] WARNING: no checksum file at ${CHECKSUM_FILE} — proceeding without verification"
fi

# ---- Decrypt (if the backup is encrypted) ------------------------------------
# Encrypted backups end in .enc (see backup.sh). The checksum above was taken
# over the encrypted file, so it is verified first; we then decrypt to a
# temporary file (cleaned up on exit) and restore from that.
case "${REAL_DUMP_FILE}" in
    *.enc)
        if [ -z "${BACKUP_ENCRYPTION_KEY}" ]; then
            echo "[restore] ERROR: '${DUMP_FILE}' is encrypted but BACKUP_ENCRYPTION_KEY is not set" >&2
            exit 4
        fi
        if ! command -v openssl >/dev/null 2>&1; then
            echo "[restore] ERROR: encrypted backup but openssl is not available to decrypt" >&2
            exit 4
        fi
        DECRYPTED_TMP="$(mktemp "${TMPDIR:-/tmp}/invenzo-restore.XXXXXX")"
        echo "[restore] Decrypting backup..."
        if ! openssl enc -d -aes-256-cbc -pbkdf2 \
                -in "${DUMP_FILE}" \
                -out "${DECRYPTED_TMP}" \
                -pass env:BACKUP_ENCRYPTION_KEY; then
            echo "[restore] ERROR: decryption failed — wrong BACKUP_ENCRYPTION_KEY or corrupt file" >&2
            exit 4
        fi
        DUMP_FILE="${DECRYPTED_TMP}"
        echo "[restore] Decrypted OK"
        ;;
esac

# ---- Show backup metadata ----------------------------------------------------
echo "[restore] Backup contents (first 20 objects):"
pg_restore --list "${DUMP_FILE}" | head -20
echo "..."

# ---- Restore -----------------------------------------------------------------
echo "[restore] Restoring ${DUMP_FILE} → ${PGDATABASE} on ${PGHOST}:${PGPORT}"
echo "[restore] WARNING: this will drop and recreate all objects in the target database."
echo "[restore] Press Ctrl-C within 5 seconds to cancel..."
sleep 5

if ! pg_restore \
        --host="${PGHOST}" \
        --port="${PGPORT}" \
        --username="${PGUSER}" \
        --dbname="${PGDATABASE}" \
        --no-owner \
        --no-acl \
        --clean \
        --if-exists \
        --verbose \
        "${DUMP_FILE}"; then
    echo "[restore] ERROR: pg_restore exited with an error — check output above" >&2
    exit 3
fi

echo "[restore] Restore complete."
echo "[restore] Run 'alembic current' to confirm the Alembic revision matches the expected head."
