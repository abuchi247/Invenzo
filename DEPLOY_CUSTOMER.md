# Deploy updates to an existing Invenzo customer

Use `scripts/deploy_customer.sh` for routine updates on the production Linux
server. It updates an existing instance; initial provisioning remains covered
by [DEPLOY_HETZNER.md](DEPLOY_HETZNER.md).

## Prerequisites

- Bash, Git, Docker Compose v2, Python 3, curl, and flock (Ubuntu: util-linux).
- A clean `main` checkout with access to `origin/main`.
- Existing `customers/<slug>/.env` and `docker-compose.override.yml` files,
  resolving to Compose project `invenzo-<slug>`.
- Running PostgreSQL, Redis, and backup-runner for that customer.
- Working HTTPS routing for `https://<slug>.<domain>` (default: `invenzo.app`).

Keep the existing customer configuration, project name, and database volumes.
Never run `down -v`, prune database volumes, replace production settings with
local settings, or seed demo data as part of deployment. The script never runs
those operations. A backup checksum confirms integrity; periodically test a
restore separately using [the operations runbook](OPERATIONS_RUNBOOK.md#4-backup-and-restore).

## First use or obtaining a script fix

Connect to the server and select the existing customer. Replace `skons` where
appropriate. Take a backup before pulling code, including when obtaining a newer
version of the deployment script:

```bash
ssh invenzo
cd ~/Invenzo
CUSTOMER=skons

prod() {
  docker compose --env-file "customers/$CUSTOMER/.env" \
    -f docker-compose.production.yml \
    -f "customers/$CUSTOMER/docker-compose.override.yml" "$@"
}

prod ps
git status --short
prod exec -e BACKUP_LABEL=pre-release backup-runner sh /backup.sh
prod exec backup-runner sh -c \
  'sha256sum -c "$(readlink -f /backups/latest.dump).sha256"'
```

Run each step separately and stop if it fails. Confirm the containers belong to
the expected instance. Resolve unexpected Git changes before continuing. Keep
an off-server backup copy and retain the encryption key before deployment.

```bash
git switch main
git pull --ff-only origin main
./scripts/deploy_customer.sh "$CUSTOMER"
```

Pulling code alone does not restart containers. The script then takes another
verified backup before updating the application. Do not discard local changes
or force Git to proceed if it reports a conflict.

## Routine deployment

```bash
ssh invenzo
cd ~/Invenzo
./scripts/deploy_customer.sh skons
```

For a custom domain:

```bash
./scripts/deploy_customer.sh skons example.com
```

The second command checks `https://skons.example.com`. Use the domain already
configured in Caddy. No preliminary `git pull` is needed for routine updates;
fetching code happens after backup verification. To obtain a fix to the script
itself, use the first-use procedure above before rerunning it.

The script performs these steps:

1. Locks the checkout against concurrent deployments and validates the instance.
2. Creates a database backup, verifies the checksum inside the container, copies
   it to the host, and verifies the exported copy.
3. Records the previous checkout commit, fetches `origin/main`, and fast-forwards.
4. Builds backend, worker, and frontend before restarting those three services
   with `--no-deps`. PostgreSQL and Redis remain running.
5. Waits for backend health, compares database revisions with the application's
   migration heads, checks running application services and public health/login.
6. Prints the deployed commit, previous commit, and backup/record directory.

Backend startup runs migrations from the fetched release. Review pending changes
before deployment; do not assume every future release is migration-free. There
may be a brief interruption when application containers restart. Deploy one
customer at a time and verify its result before moving to the next.

## Backup copies and deployment records

Each run writes a restricted, gitignored directory:

```text
customers/<slug>/deployments/<UTC-timestamp>-<process-id>/
```

It contains the backup (`.dump` or `.dump.enc`), checksum, previous commit, and,
as the run progresses, target commit and health responses. Failed runs may have
only the files created before the failure. The previous commit is the checkout
revision at invocation, not independent proof of the previously running image.

From your Mac, copy the exact directory printed by the script, substituting its
name below:

```bash
mkdir -p ~/Invenzo-backups
chmod 700 ~/Invenzo-backups
scp -r invenzo:~/Invenzo/customers/skons/deployments/REPLACE_WITH_RUN_DIRECTORY \
  ~/Invenzo-backups/
```

Retain `BACKUP_ENCRYPTION_KEY` in a password/secret manager outside the server.
Do not print or commit it. Host exports are not automatically pruned; manage
retention after confirming off-server copies and restore availability.

## Verification and failures

After success, open the production application and confirm existing inventory
and sales are present. Test customer-name and Walk-in search. Regenerate an
existing invoice to see updated item brands and Invenzo branding.

If the script stops, inspect the error and application state. It does not
perform automatic rollback, migration downgrade, or database restore.

- **Backup/checksum failure:** No code fetch or application restart has occurred.
  Resolve backup-runner, storage, or encryption issues before rerunning.
- **Git/build failure:** Existing application containers have not been restarted;
  the checkout may have advanced. Resolve the error and rerun.
- **Health/migration/public verification failure:** Application containers may
  already be running the update. Inspect health and logs before deciding on
  recovery. Do not restore the database merely because verification failed.
- **Unexpected project or missing PostgreSQL:** Confirm the original customer
  configuration. Do not change the namespace or provision a replacement stack.
- **`No module named 'alembic.config'`:** An older script imported the local
  migration package instead of the installed library. The corrected script uses
  the installed Alembic executable. Obtain the update using the first-use
  procedure and rerun. This import error alone does not indicate data loss.

Using the `prod` function from the first-use section, inspect the instance:

```bash
prod ps
prod logs --tail=100 backend worker frontend
prod exec backend alembic current
prod exec backend alembic heads
curl --fail --show-error https://skons.invenzo.app/health
```

Review logs locally before sharing them. For rollback or database recovery,
follow [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md); account for migrations
before reverting code. Never automatically restore over live business data.
