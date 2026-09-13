#!/usr/bin/env bash
# Update an EXISTING customer stack; never provision or restore a database.
set -Eeuo pipefail

main() {
    local customer=${1:-} domain=${2:-invenzo.app}
    if [[ $# -lt 1 || $# -gt 2 || ! $customer =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ || ! $domain =~ ^[a-zA-Z0-9.-]+$ ]]; then
        echo "Usage: $0 <customer-slug> [domain]" >&2
        return 1
    fi
    local root
    root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
    cd "$root"
    for tool in git docker python3 curl flock; do
        command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; return 1; }
    done
    [[ -f customers/$customer/.env && -f customers/$customer/docker-compose.override.yml ]] || {
        echo "Existing customer configuration not found." >&2; return 1;
    }
    # One deployment per checkout, including different customers sharing Git/images.
    exec 9>"$(git rev-parse --git-path invenzo-deploy.lock)"
    flock -n 9 || { echo "Another deployment is running in this checkout." >&2; return 1; }
    [[ $(git branch --show-current) == main && -z $(git status --porcelain) ]] || {
        echo "Deployment requires a clean main branch." >&2; return 1;
    }
    local -a compose=(docker compose --env-file "customers/$customer/.env"
        -f docker-compose.production.yml -f "customers/$customer/docker-compose.override.yml")
    # Resolve without displaying secrets. Refuse an unexpected Compose namespace.
    local project
    project=$("${compose[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
    [[ $project == "invenzo-$customer" ]] || {
        echo "Unexpected Compose project: $project; expected invenzo-$customer. Stop and review configuration." >&2; return 1;
    }
    compose+=(-p "$project")
    local service
    for service in postgres redis backup-runner; do
        [[ -n $("${compose[@]}" ps --status running -q "$service") ]] || {
            echo "Existing $service is not running; refusing to provision a new stack." >&2; return 1;
        }
    done
    local previous target record backup
    previous=$(git rev-parse HEAD)
    umask 077
    record="$root/customers/$customer/deployments/$(date -u +%Y%m%dT%H%M%SZ)-$$"
    mkdir -p "$record"
    printf '%s\n' "$previous" > "$record/previous-commit"
    trap 'echo "Deployment stopped. Review the error above; no automatic database restore or rollback was attempted." >&2' ERR

    echo "Creating and verifying pre-deployment backup..."
    "${compose[@]}" exec -T -e BACKUP_LABEL=pre-release backup-runner sh /backup.sh
    backup=$("${compose[@]}" exec -T backup-runner readlink -f /backups/latest.dump)
    [[ $backup == /backups/*.dump || $backup == /backups/*.dump.enc ]] || {
        echo "Unexpected backup path." >&2; return 1;
    }
    "${compose[@]}" exec -T backup-runner sha256sum -c "$backup.sha256"
    "${compose[@]}" cp "backup-runner:$backup" "$record/"
    "${compose[@]}" cp "backup-runner:$backup.sha256" "$record/"
    python3 - "$record" "${backup##*/}" <<'PY'
import hashlib, pathlib, sys
folder, name = pathlib.Path(sys.argv[1]), sys.argv[2]
expected = (folder / (name + '.sha256')).read_text().split()[0]
hash_value = hashlib.sha256()
with (folder / name).open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        hash_value.update(chunk)
if hash_value.hexdigest() != expected:
    raise SystemExit('Exported backup checksum mismatch')
PY
    echo "Verified backup copied to $record"
    echo "Keep an off-server copy and retain the existing backup encryption key."

    git fetch origin main
    target=$(git rev-parse origin/main)
    git merge-base --is-ancestor "$previous" "$target"
    printf '%s\n' "$target" > "$record/target-commit"
    git merge --ff-only "$target"
    echo "Building application images before restarting services..."
    "${compose[@]}" build backend worker frontend
    "${compose[@]}" up -d --no-deps backend worker frontend

    echo "Waiting for application health..."
    local attempt healthy=false
    for attempt in {1..30}; do
        if "${compose[@]}" exec -T backend curl -fs --max-time 5 http://localhost:8000/health > "$record/health.json" \
            && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("status")=="healthy" and all(d.get("dependencies",{}).get(k)=="up" for k in ("database","redis")) else 1)' "$record/health.json"; then
            healthy=true
            break
        fi
        sleep 2
    done
    [[ $healthy == true ]] || { echo "Backend did not become healthy." >&2; return 1; }
    # Compare the database revision set with the migration scripts in the new image.
    "${compose[@]}" exec -T backend python -c '
import asyncio
import subprocess
from sqlalchemy import text
from app.database import engine
async def check():
    # Use the installed executable: /app/alembic shadows the library in python -c.
    output = subprocess.check_output(["alembic", "heads"], text=True)
    expected = {line.split()[0] for line in output.splitlines() if "(head)" in line}
    if not expected:
        raise SystemExit("Could not determine application migration heads")
    async with engine.connect() as db:
        actual = set((await db.execute(text("SELECT version_num FROM alembic_version"))).scalars())
    await engine.dispose()
    if actual != expected:
        raise SystemExit("Database revision does not match application migration head")
asyncio.run(check())'
    for service in backend worker frontend; do
        [[ -n $("${compose[@]}" ps --status running -q "$service") ]] || return 1
    done
    curl --fail --show-error --silent --max-time 30 "https://$customer.$domain/health" > "$record/public-health.json"
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("status")=="healthy" and all(d.get("dependencies",{}).get(k)=="up" for k in ("database","redis")) else 1)' "$record/public-health.json"
    curl --fail --show-error --silent --max-time 30 -o /dev/null "https://$customer.$domain/login"
    "${compose[@]}" ps
    printf 'Deployed %s\nPrevious commit: %s\nBackup and deployment record: %s\n' "$target" "$previous" "$record"
    echo "Check existing sales, customer search, and a regenerated receipt in the browser."
}

main "$@"
