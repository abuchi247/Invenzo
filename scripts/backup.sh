#!/usr/bin/env sh
# =============================================================================
# Invenzo — PostgreSQL backup script
#
# POSIX sh — compatible with Alpine Linux's /bin/sh (ash/busybox).
#
# Usage:
#   sh /backup.sh
#
# Via docker compose (development, on-demand):
#   docker compose --profile backup run --rm backup
#   docker compose --profile backup run --rm -e BACKUP_LABEL=pre-release backup
#
# Via docker compose (production, scheduled — see docker-compose.production.yml):
#   Runs automatically at BACKUP_SCHEDULE (default: daily 02:00 UTC).
#
# Environment variables:
#   PGHOST        PostgreSQL host           (default: postgres)
#   PGPORT        PostgreSQL port           (default: 5432)
#   PGDATABASE    Database name             (falls back to POSTGRES_DB)
#   PGUSER        Database user             (falls back to POSTGRES_USER)
#   PGPASSWORD    Database password         (falls back to POSTGRES_PASSWORD)
#   BACKUP_DIR    Where to store dumps      (default: /backups)
#   BACKUP_RETAIN How many backups to keep  (default: 30)
#   BACKUP_LABEL  Optional filename label   (e.g. "pre-release")
#   BACKUP_ENCRYPTION_KEY  Optional passphrase. When set, the dump is
#                 encrypted at rest with OpenSSL AES-256-CBC (PBKDF2) and the
#                 plaintext is removed; the output gains a .enc suffix. When
#                 unset, backups stay plaintext (unchanged behaviour). restore.sh
#                 auto-detects .enc files and needs the same key to decrypt.
#
# Output files (all in BACKUP_DIR):
#   invenzo-YYYY-MM-DDTHH-MM-SS[.label].dump[.enc]        — pg_dump custom format
#                                                            (.enc when encrypted)
#   invenzo-...dump[.enc].sha256                          — SHA-256 checksum
#   latest.dump                                           — symlink to newest backup
#   backup.log                                            — append-only run log
# =============================================================================
set -eu

PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-invenzo}}"
PGUSER="${PGUSER:-${POSTGRES_USER:-postgres}}"
PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RETAIN="${BACKUP_RETAIN:-30}"
BACKUP_LABEL="${BACKUP_LABEL:-}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"

export PGPASSWORD

# ---- Validate ----------------------------------------------------------------
if [ -z "${PGPASSWORD}" ]; then
    echo "[backup] ERROR: PGPASSWORD / POSTGRES_PASSWORD is not set" >&2
    exit 1
fi

if [ ! -d "${BACKUP_DIR}" ]; then
    mkdir -p "${BACKUP_DIR}"
fi

if [ ! -w "${BACKUP_DIR}" ]; then
    echo "[backup] ERROR: backup directory '${BACKUP_DIR}' is not writable" >&2
    exit 1
fi

# ---- Filename ----------------------------------------------------------------
TIMESTAMP="$(date -u '+%Y-%m-%dT%H-%M-%S')"
if [ -n "${BACKUP_LABEL}" ]; then
    FILENAME="invenzo-${TIMESTAMP}.${BACKUP_LABEL}.dump"
else
    FILENAME="invenzo-${TIMESTAMP}.dump"
fi
FILEPATH="${BACKUP_DIR}/${FILENAME}"
LOG_FILE="${BACKUP_DIR}/backup.log"

# ---- Log helper --------------------------------------------------------------
log() {
    msg="[backup] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
    echo "${msg}"
    echo "${msg}" >> "${LOG_FILE}"
}

log "Starting: database=${PGDATABASE} host=${PGHOST}:${PGPORT} file=${FILENAME}"

# ---- pg_dump -----------------------------------------------------------------
if ! pg_dump \
        --host="${PGHOST}" \
        --port="${PGPORT}" \
        --username="${PGUSER}" \
        --dbname="${PGDATABASE}" \
        --format=custom \
        --no-owner \
        --no-acl \
        --file="${FILEPATH}"; then
    log "ERROR: pg_dump failed — removing partial file"
    rm -f "${FILEPATH}"
    exit 1
fi

BACKUP_SIZE="$(du -sh "${FILEPATH}" | cut -f1)"
log "pg_dump complete: size=${BACKUP_SIZE}"

# ---- Encryption (optional) ---------------------------------------------------
# When BACKUP_ENCRYPTION_KEY is set, encrypt the dump at rest with AES-256-CBC
# (PBKDF2 key derivation) and remove the plaintext. The checksum below is then
# taken over the encrypted file. If encryption is requested but openssl is
# missing, fail loudly and remove the plaintext dump rather than silently
# leaving an unencrypted backup on disk.
if [ -n "${BACKUP_ENCRYPTION_KEY}" ]; then
    if ! command -v openssl >/dev/null 2>&1; then
        log "ERROR: BACKUP_ENCRYPTION_KEY is set but openssl is not available — removing plaintext dump"
        rm -f "${FILEPATH}"
        exit 1
    fi
    ENC_FILEPATH="${FILEPATH}.enc"
    if ! openssl enc -aes-256-cbc -pbkdf2 -salt \
            -in "${FILEPATH}" \
            -out "${ENC_FILEPATH}" \
            -pass env:BACKUP_ENCRYPTION_KEY; then
        log "ERROR: encryption failed — removing plaintext and partial encrypted file"
        rm -f "${FILEPATH}" "${ENC_FILEPATH}"
        exit 1
    fi
    rm -f "${FILEPATH}"          # never keep the plaintext once encrypted
    FILEPATH="${ENC_FILEPATH}"   # everything downstream operates on the .enc file
    FILENAME="$(basename "${FILEPATH}")"
    log "Encrypted at rest: file=${FILENAME} (AES-256-CBC, PBKDF2)"
else
    log "WARNING: BACKUP_ENCRYPTION_KEY not set — backup is stored UNENCRYPTED"
fi

# ---- Checksum ----------------------------------------------------------------
CHECKSUM_FILE="${FILEPATH}.sha256"
if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${FILEPATH}" > "${CHECKSUM_FILE}"
    CHECKSUM="$(cut -d' ' -f1 "${CHECKSUM_FILE}")"
    log "Checksum: sha256=${CHECKSUM}"
elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${FILEPATH}" > "${CHECKSUM_FILE}"
    CHECKSUM="$(cut -d' ' -f1 "${CHECKSUM_FILE}")"
    log "Checksum: sha256=${CHECKSUM}"
else
    log "WARNING: sha256sum / shasum not found — checksum skipped"
fi

# ---- Latest symlink ----------------------------------------------------------
ln -sf "${FILEPATH}" "${BACKUP_DIR}/latest.dump"
log "Symlink updated: latest.dump -> ${FILEPATH}"

# ---- Retention ---------------------------------------------------------------
# Count existing dumps; delete oldest ones beyond the retain limit. The glob
# "invenzo-*.dump*" matches both plaintext (.dump) and encrypted (.dump.enc)
# backups; the "! -name *.sha256" exclusion drops the checksum sidecars.
TOTAL=$(find "${BACKUP_DIR}" -maxdepth 1 -name "invenzo-*.dump*" \
          ! -name "*.sha256" | wc -l | tr -d ' ')
DELETE_COUNT=$((TOTAL - BACKUP_RETAIN))

if [ "${DELETE_COUNT}" -gt 0 ]; then
    log "Retention: keeping ${BACKUP_RETAIN} of ${TOTAL}, removing ${DELETE_COUNT} old backup(s)"
    find "${BACKUP_DIR}" -maxdepth 1 -name "invenzo-*.dump*" \
        ! -name "*.sha256" | sort | head -n "${DELETE_COUNT}" | while read -r OLD; do
        log "Removing: ${OLD}"
        rm -f "${OLD}" "${OLD}.sha256"
    done
fi

# ---- Summary -----------------------------------------------------------------
REMAINING=$(find "${BACKUP_DIR}" -maxdepth 1 -name "invenzo-*.dump*" \
              ! -name "*.sha256" | wc -l | tr -d ' ')
log "Done. Retained ${REMAINING}/${BACKUP_RETAIN} backup(s)."
log "---"
