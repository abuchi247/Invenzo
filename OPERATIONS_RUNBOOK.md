# Production Operations Runbook

This runbook describes the minimum operating procedure for Invenzo deployments. It applies to the Docker Compose deployment in this repository and to managed container hosts such as Render (see [DEPLOYMENT.md](DEPLOYMENT.md)), and should be reviewed whenever the application, migrations, or infrastructure dependencies change.

## 1. Release prerequisites and ownership

Before a production release, the release operator must have:

- Access to the production secret manager, PostgreSQL backup store, Redis service, deployment platform, and error-tracking project.
- A tested application image identified by an immutable commit or image digest.
- A database backup from immediately before a schema-changing release.
- A migration review that identifies whether the release is backward-compatible with the currently running application.
- A rollback decision owner and a maintenance/traffic plan for migrations that may lock or rewrite large tables.

Do not use the development Compose defaults in production. In particular, do not use `changeme`, `change-me-in-production`, `dev-secret-key-not-for-production`, demo users, or localhost origins.

## 2. Secrets and required environment variables

### Secret-manager rules

All production credentials and CI credentials must be supplied by a managed secret store or the deployment platform's encrypted variable store. They must not be committed to Git, copied into an image, placed in a Dockerfile, pasted into issue trackers, or printed in deployment logs. Examples include the PostgreSQL password, `JWT_SECRET_KEY`, SMTP password, database/Redis URLs containing credentials, deployment tokens, CI tokens, and error-tracker authentication tokens.

Use separate secret-manager entries and rotation schedules for development, staging, and production. Grant read access only to the backend, worker, migration job, and CI steps that need a value. Do not reuse the same JWT or database password across environments. Rotating `JWT_SECRET_KEY` invalidates existing JWTs; plan a coordinated session re-authentication when doing so.

A secret manager is required even if the deployment platform exposes environment variables: the platform variable must be populated from the encrypted store, not from a committed `.env` file. `.env.example` contains placeholders only. The local `.env` file is ignored by Git and must still never be uploaded or attached to a ticket.

### Generate secrets

Generate a JWT signing secret with at least 32 random bytes. The following commands print a value to the terminal; store the result directly in the secret manager rather than in shell history or a committed file:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
openssl rand -base64 32
```

Generate a database password with the password policy required by the managed PostgreSQL service. Do not use a human-readable word or a value from this runbook. After storing the values, verify that the deployment injects them into the intended service without echoing them.

### Required production configuration

The exact variable names depend on the deployment path:

| Variable | Required value/meaning |
|---|---|
| `ENVIRONMENT` | `production`; this enables production validation and disables public `/docs`, `/redoc`, and `/openapi.json`. |
| `JWT_SECRET_KEY` | A random, non-placeholder value of at least 32 characters for a direct backend deployment. Docker Compose maps the `SECRET_KEY` project variable to this setting. |
| `POSTGRES_PASSWORD` | A unique, non-placeholder database password. A direct deployment may instead provide a credential-bearing `DATABASE_URL`; never put that URL in source control. |
| `POSTGRES_USER`, `POSTGRES_DB` | The production database role and database name when Compose or a managed database uses separate variables. |
| `DATABASE_URL` | The async PostgreSQL URL for direct deployments (`postgresql+asyncpg://...`). Compose constructs it from the PostgreSQL variables. |
| `MIGRATION_DATABASE_URL` | Separate async PostgreSQL URL with DDL-capable credentials for the migration step. Falls back to `DATABASE_URL` when not set. Production SHOULD use a dedicated migration identity for least-privilege enforcement. |
| `REDIS_URL` | The production Redis URL for sessions, rate limiting, and ARQ. `docker-compose.production.yml` constructs it as `redis://:${REDIS_PASSWORD}@redis:6379/0`. |
| `REDIS_PASSWORD` | Required by the production stack. Redis starts with `--requirepass` and the API/worker URLs must carry the same value, or every session, rate-limit, and job operation fails. |
| `CORS_ORIGINS` | Only the trusted production frontend origin(s), not `*` and not localhost. |
| `FRONTEND_BASE_URL` | The public frontend origin used to build password-reset links. |
| `NEXT_PUBLIC_API_URL` | The frontend's public API base URL, including `/api/v1` and no trailing slash. |
| `SMTP_HOST`, `SMTP_FROM_EMAIL` | Required outside development for password-reset delivery. |
| `SMTP_PORT`, `SMTP_USE_TLS` | SMTP connection settings; use TLS according to the provider's requirements. |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | Required when the SMTP provider authenticates; inject the password from the secret manager. |

Also review the bounded operational settings before launch: `JWT_ACCESS_TOKEN_EXPIRE_MINUTES`, `JWT_REFRESH_TOKEN_EXPIRE_DAYS`, `MAX_REQUEST_BODY_BYTES`, the `RATE_LIMIT_*` values, `JOB_MAX_TRIES`, `JOB_BASE_BACKOFF_SECONDS`, `JOB_MAX_BACKOFF_SECONDS`, `JOB_TIMEOUT_SECONDS`, and `JOB_MAX_CONCURRENCY`. Keep `RUN_MIGRATIONS_ON_STARTUP=false` when migrations are run as a separate deployment step; set it to `true` only for a deliberately serialized startup migration strategy.

Error tracking is optional in local development but should be configured in staging and production. Set `ERROR_TRACKER_ENABLED=true`, provide `ERROR_TRACKER_DSN`, and set `ERROR_TRACKER_ENVIRONMENT` and `ERROR_TRACKER_RELEASE` to identify the deployment. Keep `ERROR_TRACKER_SAMPLE_RATE` within the provider's approved budget. The backend adapter scrubs credentials, cookies, authorization values, passwords, tokens, and database URLs before reporting.

For Docker Compose, create a local `.env` from `.env.example` only for development. For production, inject the same names through the deployment secret store and review the Compose file's service-specific environment mapping. Do not publish PostgreSQL or Redis ports to the public internet.

### Compose files: which file is production

`docker-compose.yml` is development/CI only: it bind-mounts the host source into the containers and publishes PostgreSQL and Redis on the host. `docker-compose.production.yml` is a **standalone** production stack and must be used on its own:

```bash
docker compose -f docker-compose.production.yml up -d
```

Do not combine the two files. Compose merges list-valued keys (`volumes`, `ports`) instead of replacing them, so an override cannot remove the development source mounts or the published database ports — the merged result silently keeps them. `backend/tests/unit/test_deployment_config.py` asserts the production stack has no host mounts, no published datastore ports, non-root/read-only containers, an authenticated Redis URL, deployment-supplied browser origins, and the ARQ worker command.

The production stack binds the backend and frontend to `127.0.0.1` by default (`BACKEND_BIND_ADDR`, `FRONTEND_BIND_ADDR`) on the assumption that TLS terminates at a reverse proxy on the same host. Change those only if the proxy runs elsewhere on a trusted network.

## 3. Database migrations and startup failure behavior

Alembic is the only schema-management path. Application startup does not call `Base.metadata.create_all` or apply inline `ALTER TABLE` statements. The backend image runs migrations before Uvicorn:

```bash
docker compose -f docker-compose.production.yml run --rm backend alembic upgrade head
docker compose -f docker-compose.production.yml up -d backend worker
```

The image command is equivalent to `alembic upgrade head && exec uvicorn ...`; if the migration command exits non-zero, Uvicorn is not started. A deployment platform should run the migration as a single release/pre-deploy job, wait for success, and only then enable backend traffic. Concurrent replica starts are also serialized in the application itself: `backend/alembic/env.py` takes the PostgreSQL advisory lock `784231905` for the duration of the upgrade and releases it afterwards, so a second instance waits instead of running the same revision twice. Treat that as a safety net, not as a substitute for a single ordered migration step. The migration uses `MIGRATION_DATABASE_URL` when set so the DDL identity stays separate from the application identity.

For a direct backend checkout, run from `backend/` with the production environment injected:

```bash
alembic upgrade head
alembic current
alembic history --verbose
```

Before applying a migration:

1. Confirm the target commit and migration head in the release artifact.
2. Confirm PostgreSQL connectivity and available storage.
3. Take and verify a fresh backup (see Section 4).
4. Review the migration for locks, table rewrites, data backfills, and downgrade limitations.
5. Apply it once in staging using a production-like snapshot where possible.

After applying it, verify `alembic current` reports the expected head, call `/health`, and inspect application and migration logs. Migration logs may contain revision names and safe outcomes, but must not contain connection strings or credentials.

### Migration rollback inventory

The revision chain is linear (`0001` → `0007`) and every revision defines a `downgrade()`, so a single-step rollback is mechanically possible. Mechanically possible is not the same as safe: the destructive column and table drops below lose data permanently.

| Revision | Change | `downgrade()` effect | Data loss on downgrade |
|---|---|---|---|
| `0001` | `uuid-ossp` extension | Drops the extension | None (fresh database only) |
| `0002` | Base tables and indexes | Drops those tables/indexes | Total for those tables |
| `0003` | `invoice_number_seq` sequence | Drops the sequence | Loses the current invoice counter |
| `0004` | Performance indexes | Drops the indexes (`IF EXISTS`) | None |
| `0005` | `business_settings` table | Drops the table | All business settings |
| `0006` | Sales/supplier-ledger indexes | Drops the indexes (`IF EXISTS`) | None |
| `0007` | `sales.amount_paid` column | Drops the column | All recorded payment amounts |

Index-only downgrades (`0004`, `0006`) are safe to run in production if a release must be reverted. For `0003`, `0005`, and `0007`, prefer restoring the pre-release backup over running the downgrade, and never run a downgrade that drops a column or table while the previous application version is still writing to it.

```bash
# Verify state first; alembic must report the expected head.
docker compose -f docker-compose.production.yml run --rm backend alembic current

# Single-step rollback of an index-only revision, after review and a backup.
docker compose -f docker-compose.production.yml run --rm backend alembic downgrade -1
```

If a migration fails, the migration job and deployment must fail closed: keep the old application serving only if its schema remains safe, or remove traffic according to the deployment plan. Never start an application against a partially migrated schema. Capture the failure and revision in the deployment record, fix or replace the migration, restore the pre-migration backup when data was changed, and rerun the reviewed migration. Do not manually patch production with ad hoc SQL and do not mark a failed revision as applied.

## 4. Backup and restore

PostgreSQL is the source of truth for financial, inventory, audit, and user data. Redis contains sessions, rate-limit state, and background-job state; it is not a substitute for a PostgreSQL backup.

### When backups run

The production Compose stack includes a scheduled backup service. Start the full stack with:

```bash
docker compose -f docker-compose.production.yml up -d
```

This starts `backup-scheduler` (Ofelia cron) and `backup-runner`. Ofelia reads the schedule label from `backup-runner` and executes `sh /backup.sh` inside that running container at the configured time. The default schedule is daily at **02:00 UTC**.

Run an on-demand backup before deployments, schema migrations, destructive customer/inventory/financial changes, infrastructure maintenance, database restores, or any risky operational test. A restore is for a recovery event or restore drill, not a normal deployment step; perform drills against a temporary database.

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_SCHEDULE` | `0 2 * * *` | Cron expression — daily at 02:00 UTC |
| `BACKUP_RETAIN` | `30` | Number of daily dumps to keep locally |
| `BACKUP_ENCRYPTION_KEY` | (unset) | Passphrase for at-rest encryption. When set, dumps are encrypted with OpenSSL AES-256-CBC (PBKDF2) and the plaintext is removed. When unset, dumps are plaintext. `provision_customer.sh` generates one per customer. **Keep it safe — you need it to restore, and losing it makes the encrypted backups unrecoverable.** |

Backup files land in the `backup-data` Docker named volume:
- `invenzo-YYYY-MM-DDTHH-MM-SS.dump` — pg_dump custom format (unencrypted)
- `invenzo-YYYY-MM-DDTHH-MM-SS.dump.enc` — AES-256-CBC encrypted dump (when `BACKUP_ENCRYPTION_KEY` is set)
- `invenzo-....dump[.enc].sha256` — SHA-256 checksum (over the stored file)
- `latest.dump` — symlink to the most recent backup (`.dump` or `.dump.enc`)
- `backup.log` — append-only log of every backup run

> **Encryption & restore:** `restore.sh` auto-detects `.enc` files, verifies the
> checksum, then decrypts to a temporary file (removed on exit) before
> restoring — so it needs `BACKUP_ENCRYPTION_KEY` in its environment (the
> backup-runner container already has it from the `.env`). Plaintext `.dump`
> files restore unchanged, so older backups remain recoverable.

Check backup logs:
```bash
docker compose -f docker-compose.production.yml exec backup-runner cat /backups/backup.log
```

List available backups:
```bash
docker compose -f docker-compose.production.yml exec backup-runner ls -lh /backups/
```

### On-demand backup

Development backups use the `backup` profile and write to `./backups/`:
```bash
docker compose --profile backup run --rm backup
docker compose --profile backup run --rm -e BACKUP_LABEL=pre-release backup
```

For production, use `exec` against the already-running runner. This is important for encrypted backups because the production runner installs OpenSSL during startup; a new `run --rm` container can bypass that initialization:
```bash
docker compose -f docker-compose.production.yml exec backup-runner sh /backup.sh
docker compose -f docker-compose.production.yml exec -e BACKUP_LABEL=pre-release \\
  backup-runner sh /backup.sh
```

For a per-customer deployment, include its environment and override files:
```bash
docker compose --env-file customers/<slug>/.env \\
  -f docker-compose.production.yml \\
  -f customers/<slug>/docker-compose.override.yml \\
  exec backup-runner sh /backup.sh
```

Confirm the new dump and checksum exist before continuing with the risky operation:
```bash
docker compose --env-file customers/<slug>/.env \\
  -f docker-compose.production.yml \\
  -f customers/<slug>/docker-compose.override.yml \\
  exec backup-runner ls -lh /backups
```

The backup lands in `./backups/` (development) or the `backup-data` volume (production).

### Off-site storage

The `backup-data` named volume stores backups on the Docker host. Move copies off-site to survive host failure:

```bash
# Copy the latest backup to S3
docker run --rm \
  -v invenzo_backup-data:/backups:ro \
  -e AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  amazon/aws-cli s3 cp /backups/latest.dump \
    "s3://${BACKUP_BUCKET}/invenzo/$(date -u +%Y/%m/%d)/latest.dump"
```

For managed PostgreSQL services (Render, Supabase, RDS), use the platform's point-in-time backup and restore instead of the self-managed script.

### Restore drill in an isolated database

**Never restore directly into the live production database without a reviewed maintenance plan.** The target database must already exist because `pg_restore` restores objects but does not create the database.

For a customer deployment, create a temporary database and restore through `backup-runner`, which has `/restore.sh`, `/backups`, OpenSSL, and the encryption key:

```bash
docker compose --env-file customers/<slug>/.env \\
  -f docker-compose.production.yml \\
  -f customers/<slug>/docker-compose.override.yml \\
  exec postgres sh -c \\
  'psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE invenzo_restore_test;"'

docker compose --env-file customers/<slug>/.env \\
  -f docker-compose.production.yml \\
  -f customers/<slug>/docker-compose.override.yml \\
  exec -e PGDATABASE=invenzo_restore_test backup-runner \\
  sh /restore.sh /backups/latest.dump
```

`restore.sh` verifies the checksum when present, detects `.dump.enc`, decrypts it with `BACKUP_ENCRYPTION_KEY`, restores the custom-format dump, and removes the temporary decrypted file. Legacy plaintext `.dump` backups remain supported. It shows the first 20 archive objects and waits five seconds before restoring.

After the drill, remove the temporary database:

```bash
docker compose --env-file customers/<slug>/.env \\
  -f docker-compose.production.yml \\
  -f customers/<slug>/docker-compose.override.yml \\
  exec postgres sh -c \\
  'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE invenzo_restore_test;"'
```

For local development, create the target database first and override the backup service entrypoint so `/restore.sh` is invoked instead of `/backup.sh`:

```bash
docker compose exec postgres sh -c \\
  'psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE invenzo_restore_test;"'
docker compose --profile backup run --rm --entrypoint sh \\
  -e PGDATABASE=invenzo_restore_test backup \\
  /restore.sh /backups/latest.dump
```


```bash
# 1. Verify backup integrity
docker-compose run --rm --profile backup -e PGDATABASE=invenzo_restore \
  bash -c "sha256sum --check /backups/latest.dump.sha256"

# 2. Restore into an isolated test database
PGDATABASE=invenzo_restore \
  docker-compose run --rm --profile backup backup \
  sh /restore.sh /backups/latest.dump

# 3. Run the restore script directly (shows interactive 5-second warning)
docker exec invenzo-postgres sh /restore.sh /backups/latest.dump
```

Or using the restore script locally:
```bash
PGHOST=localhost PGPORT=5432 \
PGDATABASE=invenzo_restore \
PGUSER=postgres PGPASSWORD=<password> \
bash scripts/restore.sh ./backups/latest.dump
```

After restore, always verify:
```bash
# 1. Check the Alembic revision matches the backup
docker exec invenzo-backend alembic current

# 2. Check the health endpoint
curl http://localhost:8000/health

# 3. Spot-check critical table counts
docker exec invenzo-postgres psql \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT COUNT(*) FROM sales; SELECT COUNT(*) FROM spare_parts; SELECT COUNT(*) FROM users;"
```

### Production backup requirements

- Automated daily backups with a documented retention period that meets the business recovery-point objective.
- Point-in-time recovery or an equivalent managed-database capability where required by the service-level objective.
- An encrypted copy in a separate failure domain/account, with access restricted to recovery operators.
- Monitoring for backup success, age, storage capacity, and restore-point availability (alert on `backup.log` age > 25 hours).
- A restore drill at a scheduled interval. Record the restore duration, recovered migration revision, and integrity checks.

Take an on-demand backup before each release that changes the schema or performs a destructive data operation.

## 5. Health, readiness, and API documentation

`GET /health` is the deployment readiness check. It concurrently performs a bounded PostgreSQL `SELECT 1` and Redis `PING` (two seconds per dependency by default) and returns safe dependency state:

- `200` with `{"status":"healthy", "dependencies":{"database":"up", "redis":"up"}}` when both critical dependencies are available.
- `503` with `{"status":"unhealthy", ...}` when either dependency is down or times out.

The response also includes the application version and commit identifier when available. It does not include URLs, credentials, exception text, or stack traces. Configure the load balancer/orchestrator to remove an instance from service on a `503`; do not treat a failed readiness check as proof that data is corrupt.

`GET /api/v1/status` is a lightweight application status endpoint. It reports the service version/environment and is not a replacement for `/health` when dependency readiness matters. There is no separate dependency-free liveness endpoint in this repository; add one at the platform layer if the orchestrator requires distinct liveness and readiness probes.

### Non-browser API client compatibility (refresh/logout)

Browsers use the HTTP-only refresh cookie: `POST /api/v1/auth/login` sets `asm_refresh` (HTTP-only, `Secure`, `SameSite=strict`, path `/api/v1/auth`), and `POST /api/v1/auth/refresh` and `/api/v1/auth/logout` are called with no request body. When a request carries the cookie, the server also validates the browser-declared `Origin`/`Referer` against `CORS_ORIGINS`, `FRONTEND_BASE_URL`, and the request host, and returns `403` for anything else. Misconfiguring those two variables therefore breaks browser refresh, which is why the production stack requires them from the deployment environment. The default `SameSite=strict` assumes the UI and API share a site; if they do not, set `REFRESH_COOKIE_SAMESITE=none` (which production requires to be paired with a `Secure` cookie), because a `strict` or `lax` cookie is not attached to the cross-site refresh request at all.

The request-body flow is retained for non-browser clients: `{"refresh_token": "..."}` is accepted on both endpoints, the origin check is skipped when no `Origin`/`Referer` header is present, and the cookie takes precedence when both are supplied. One rollout detail matters: the refresh credential is never returned in a JSON response, so a non-browser client obtains it from the login response's `Set-Cookie` header, and gets each rotated credential from the `Set-Cookie` header of the refresh response.

- Any HTTP library with a cookie jar (`requests.Session`, `httpx.Client`, `curl -c/-b`) works unchanged: it stores and replays the cookie automatically.
- A client that ignores cookies must read the credential out of `Set-Cookie` and send it in the body:

```bash
# Login, capturing the refresh cookie into a jar.
curl -sS -c jar.txt -X POST https://api.example.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"...","password":"..."}'

# Refresh using the jar (no body needed), or extract the value and send it in the body.
curl -sS -b jar.txt -c jar.txt -X POST https://api.example.com/api/v1/auth/refresh
```

Each refresh rotates both the cookie and the Redis session entry, so a client must always use the newest credential; a replayed old one is rejected and its cookie is expired. This body flow is a compatibility path, not a permanent contract: before removing it, inventory integration clients, confirm they handle cookies or `Set-Cookie`, and announce the change. `backend/tests/unit/test_refresh_cookie.py` covers cookie attributes, cookie-over-body precedence, rotation, logout revocation, origin rejection, and the full cookie-less login/refresh/logout procedure above.

In production, public `/docs`, `/redoc`, and `/openapi.json` are disabled. Internal API documentation is available at `/internal/docs` and `/internal/openapi.json` only after Admin authentication, and should additionally be restricted by private ingress/network policy. Never expose those internal routes through a public unauthenticated proxy.

## 6. Background worker operation

Password-reset email delivery and future report generation use ARQ on the existing Redis service. The worker is a separate process from the API and must run continuously in staging/production:

```bash
docker compose -f docker-compose.production.yml up -d worker
docker compose -f docker-compose.production.yml logs -f worker
```

The configured command is:

```bash
arq app.services.background_jobs.WorkerSettings
```

The worker runs the same image as the API but overrides the image command, so it does **not** apply migrations; the API/migration step owns the schema. It restarts under `restart: unless-stopped`, has no HTTP health endpoint, and starts only after PostgreSQL and Redis report healthy. Monitor it through its structured logs and the queue-depth/job-failure metrics rather than a readiness probe. Failure handling in code: transient SMTP/network errors raise a retryable error and are deferred with bounded exponential backoff (`JOB_BASE_BACKOFF_SECONDS` doubling up to `JOB_MAX_BACKOFF_SECONDS`) until `JOB_MAX_TRIES`, after which the outcome is logged as `terminal_failure`; unknown exceptions are treated as terminal rather than retried, so a job with an unproven transient cause cannot duplicate a side effect.

The worker and API must use the same `REDIS_URL` and `JOB_QUEUE_NAME`. Review `JOB_MAX_CONCURRENCY`, `JOB_TIMEOUT_SECONDS`, `JOB_MAX_TRIES`, and the bounded exponential backoff settings against SMTP capacity and database capacity. Scale workers only after checking Redis queue behavior and database connection limits.

Worker logs emit safe job telemetry with job ID, job name, attempt, and outcome (`success`, `retry`, or `terminal_failure`). They intentionally do not log recipients, reset URLs, tokens, passwords, or exception payloads. A missing worker or Redis outage means queued password-reset messages may not be delivered; alert on worker restarts, terminal failures, and sustained queue backlog. The current operational status mechanism is structured worker logging; no public job-status endpoint is exposed.

For maintenance, stop accepting new application traffic first when required, allow a bounded worker drain, then stop the worker. Do not delete the Redis volume as a routine recovery step: that discards sessions and queued jobs.

## 7. Error tracking and incident response

Enable the configured error tracker only in staging/production after confirming the DSN belongs to the correct project and environment. Set a release identifier to the deployed commit or image. Verify one controlled test event in staging, then confirm alert routing and ownership. Do not use a production DSN in local development.

The backend catches unexpected request-lifecycle exceptions, records safe route/method/request-ID context, and returns a generic 5xx response in staging/production. Expected HTTP and validation errors retain their normal status and safe details. Before investigating an event, correlate its request ID with structured API logs and deployment/migration logs. Redact customer data and credentials before sharing event details.

The backend adapter is the currently configured provider boundary. Frontend error boundaries and client-side reporting must use the equivalent provider project/environment when that integration is enabled; never put access tokens, refresh cookies, passwords, reset URLs, or customer-sensitive request bodies in breadcrumbs. A browser-visible DSN is not a substitute for a secret-manager-controlled release configuration, and CI upload/authentication tokens must remain server-side secrets.

Error tracking is diagnostic, not a data backup or uptime monitor. Keep `/health` monitoring, worker alerts, database backup alerts, and deployment failure alerts independent of the error-tracker provider. If the provider is unavailable, the application must continue serving and log that reporting is unavailable without failing requests.

## 8. Release, rollback, and recovery procedure

### Required CI checks and branch protection

Both workflows run on pushes to `main` and on pull requests targeting `main`. Configure branch protection on `main` to require these status checks (names must match the workflow job names exactly), plus a pull-request review and up-to-date branches:

| Required check | Workflow | Covers |
|---|---|---|
| `Validate lockfiles` | `CI Pipeline` | Pinned `backend/requirements.txt`, `npm ci` lockfile sync |
| `Backend checks` | `CI Pipeline` | Backend compile check and full pytest suite (including Hypothesis property tests) |
| `Frontend checks` | `CI Pipeline` | ESLint, `tsc --noEmit`, unit/component tests, production build, bundle budget |
| `Frontend performance budgets` | `CI Pipeline` | Lighthouse Core Web Vitals and accessibility score against the production build |
| `Dependency vulnerability scan` | `CI Pipeline` | `pip-audit` (backend) and `npm audit --audit-level=high` (frontend) |
| `Build and scan containers` | `CI Pipeline` | Backend/frontend image builds, Trivy CRITICAL/HIGH gate, non-root and metadata verification |
| `Playwright login and sale flow` | `Frontend Playwright E2E` | Login plus one core business flow against controlled services |

`pip-audit` has no severity-threshold option, so the backend scan fails on **any** known advisory. Accepted risks are recorded in `.security-exceptions.yml` with a severity, reason, reviewer, and expiry; `.github/scripts/security_exceptions.py` converts unexpired entries into `--ignore-vuln` flags and drops expired ones so the scan turns red again and forces a re-review. Critical/high exceptions may not exceed 30 days, medium/low 90 days. The frontend scan is thresholded at `high` by `npm audit`.

Local equivalents of the gates:

```bash
cd backend && pytest && docker build -t invenzo-backend:check .
cd frontend && npm ci && npm run lint && npx tsc --noEmit && npm test && npm run build && npm run perf:bundle
cd frontend && npm run e2e            # requires the backend stack and E2E_USERNAME/E2E_PASSWORD
python .github/scripts/security_exceptions.py
```

The Playwright workflow needs the `E2E_USERNAME` and `E2E_PASSWORD` repository secrets; without them the login test cannot run, so verify they exist before making that check required.

### Normal release

1. Build and test the immutable backend and frontend artifacts from a reviewed commit.
2. Verify production secrets and non-secret configuration through the deployment platform; do not print values.
3. Take the pre-release PostgreSQL backup and record its identifier.
4. Run `alembic upgrade head` as the serialized migration step.
5. Start/roll the backend, worker, and frontend, then wait for `/health` to return `200`.
6. Check `/api/v1/status`, worker logs, error-tracker release, and one authenticated smoke flow.
7. Monitor dependency health, error rate, worker terminal failures, latency, and database capacity during the release window.

### Application-only rollback

If the schema is backward-compatible and the issue is in application code, redeploy the previous known-good backend/frontend image and worker image using the deployment platform. Keep the database at the current Alembic head, verify `/health`, and ensure the worker and API are running compatible code. Do not roll back application code across an incompatible migration.

### Migration/data rollback

If a migration changed data or schema incompatibly:

1. Stop the release and remove traffic if the current application cannot safely operate.
2. Preserve logs, the failed revision, deployment commit, and backup identifier.
3. Prefer a reviewed forward migration for additive changes. Do not run an unreviewed downgrade against production.
4. For destructive or unrecoverable changes, restore the pre-release PostgreSQL backup/PITR target into the approved recovery environment, validate its Alembic revision and critical ledger counts, then switch the application to the recovered database according to the platform procedure.
5. Deploy an application version compatible with that restored revision, start the worker with the matching code, and run the full smoke checks.
6. Reconcile writes accepted after the backup from audit/business records before reopening traffic. Document any data loss against the recovery objective.

After any rollback, rotate credentials if they may have appeared in diagnostics, invalidate sessions if authentication state is uncertain, and schedule a post-incident review. Never delete backups, migration files, or logs while investigating an incident.

### Rollout and rollback readiness checklist

Run through this before enabling production traffic for the first time, and before any release that changes authentication, migrations, or the worker.

Authentication rollout:

- [ ] `CORS_ORIGINS` and `FRONTEND_BASE_URL` name the real production frontend origin (the cookie origin check rejects everything else).
- [ ] `REFRESH_COOKIE_SECURE` is not `false`; production startup rejects that combination.
- [ ] `REFRESH_COOKIE_SAMESITE` matches the hosting model: `strict` when the UI and API share a site, `none` (with `Secure`) when they do not, because a `strict`/`lax` cookie is not sent on a cross-site refresh request and browser sessions would silently fail to restore.
- [ ] Integration clients either handle cookies or read the credential from `Set-Cookie` (see Section 5).
- [ ] Browser login → refresh → logout verified against the deployed origin over HTTPS.

Database and migrations:

- [ ] Fresh pre-release backup taken, listed/verified, and its identifier recorded.
- [ ] `alembic current` matches the migration head recorded in the release artifact.
- [ ] The release's migrations reviewed against the rollback inventory in Section 3; destructive revisions have a restore plan instead of a downgrade.
- [ ] A restore verification has been run within the current cycle (Section 14).
- [ ] Application and migration database identities are separate in production (Section 12).

Worker:

- [ ] Worker container running from the same image/commit as the API, sharing `REDIS_URL` and `JOB_QUEUE_NAME`.
- [ ] `REDIS_PASSWORD` present in both the Redis command and the API/worker URLs.
- [ ] SMTP host/from-address/credentials configured; a controlled password-reset delivery observed in staging.
- [ ] Alerts wired for worker restarts, terminal job failures, and sustained queue depth.

CI and monitoring:

- [ ] All checks in the table above are configured as required on `main`, and `E2E_USERNAME`/`E2E_PASSWORD` secrets exist.
- [ ] `ERROR_TRACKER_ENABLED=true` **with** a real `ERROR_TRACKER_DSN` and a release identifier; an empty DSN silently disables reporting.
- [ ] `/health` monitored by the load balancer with `503` removing the instance from service.
- [ ] Log pipeline ingesting the JSON records and the telemetry metrics in Section 10, with the alert thresholds and owners in that table configured.

Rollback:

- [ ] Previous known-good image tags identified for backend, worker, and frontend.
- [ ] Rollback decision owner named for the release window.
- [ ] Confirmed whether the release is backward-compatible with the previous application version (determines application-only vs data rollback).

## 9. Supported frontend/runtime versions

The supported baseline is the pinned dependency set in `frontend/package-lock.json` and `backend/requirements.txt`:

| Component | Supported baseline |
|---|---|
| Next.js | `16.3.0` (App Router) |
| React / React DOM | `18.2.0` |
| TypeScript | `5.3.3` |
| Node.js container runtime | `20` (`node:20-alpine3.22`) |
| Python | `3.11` |
| PostgreSQL | `15` (`postgres:15-alpine` in Compose) |
| Redis | `7` (`redis:7-alpine` in Compose) |

Do not treat a major-version upgrade as a routine patch. The hardening design intentionally does not require Next.js 15 or React 19. Any deployment using versions outside this table must be explicitly tested and recorded as an exception.

## 10. Performance budgets, SLOs, and alert ownership

### API performance budgets

These are initial thresholds derived from the application's expected workload and user expectations. They must be recalibrated from production evidence within the first release cycle and reviewed quarterly thereafter.

| Category | Target | Measurement |
|---|---|---|
| Authenticated CRUD endpoints (p95 latency) | < 500 ms | Server-side from telemetry middleware |
| Report/export endpoints (p95 latency) | < 2000 ms | Server-side from telemetry middleware |
| Login/refresh/logout (p95 latency) | < 300 ms | Server-side from telemetry middleware |
| Health check (p99 latency) | < 500 ms | Server-side |
| API error rate (5xx, excluding expected 4xx) | < 1% of total requests | Telemetry counters by status class |
| Database pool wait time (p95) | < 100 ms | `db_pool_wait_ms` histogram |
| Background job execution (p95) | < 30 s (email), < 120 s (reports) | `job_duration_ms` histogram |
| Background queue depth (sustained) | < 100 pending jobs | `queue_depth` gauge |

### Frontend performance budgets

`frontend/performance-budgets.json` is the machine-readable source of truth. It is enforced by
`frontend/scripts/check-bundle-budget.mjs` (JavaScript weight), `frontend/lighthouserc.json`
(Core Web Vitals and Lighthouse accessibility score), and the Playwright
`performance-accessibility` projects (route load time, axe scans). The table below mirrors that
file; change both together.

Measured against production builds (`next build` + `next start`), never development mode, on a
1440x900 desktop and a 393x851 mobile viewport:

| Metric | Budget | Tool |
|---|---|---|
| Initial route JavaScript (default) | < 300 KB gzipped | `npm run perf:bundle` |
| Initial route JavaScript (`/inventory`, `/reports`) | < 320 KB gzipped | `npm run perf:bundle` |
| Initial route JavaScript (`/login`) | < 260 KB gzipped | `npm run perf:bundle` |
| Largest Contentful Paint (LCP) | < 2.5 s | Lighthouse CI |
| Interaction to Next Paint (INP) | < 200 ms | Lighthouse CI / Real User Monitoring |
| Cumulative Layout Shift (CLS) | < 0.1 | Lighthouse CI |
| Total Blocking Time (TBT) | < 300 ms | Lighthouse CI |
| Route load time (authenticated navigation) | < 1.5 s | Playwright timing |
| Lighthouse accessibility score | >= 0.90 | Lighthouse CI |
| axe violations (critical/serious) | 0 | Playwright axe scan + Vitest component scans |

### Alert thresholds and ownership

| Condition | Severity | Owner | Action |
|---|---|---|---|
| API p95 > 500 ms for 5 min | Warning | Backend team | Investigate slow queries, pool saturation |
| API error rate > 1% for 5 min | Critical | Backend team | Check deployment, migrations, dependency health |
| Database pool saturation > 80% | Warning | Backend/Infra | Scale pool or reduce concurrency |
| Redis errors > 10/min sustained | Critical | Backend/Infra | Check Redis connectivity, failover |
| Background queue depth > 100 for 10 min | Warning | Backend team | Scale workers or investigate job failures |
| Worker job failure rate > 5% | Critical | Backend team | Check SMTP, dependency availability |
| Health endpoint returning 503 | Critical | Infra/On-call | Route traffic away, investigate dependency |
| Frontend LCP > 2.5 s (production check) | Warning | Frontend team | Profile bundle, check API latency |

### Telemetry metrics reference

The telemetry adapter records the following metrics. In production, they are emitted as structured log records consumable by CloudWatch, Datadog, Loki, or equivalent pipelines:

- `http_requests_total` — request count by method, route, status class
- `http_request_duration_ms` — latency histogram by method and route
- `db_pool_wait_ms` — database connection acquisition time
- `db_slow_queries_total` — count of queries exceeding the configured threshold
- `redis_errors_total` — Redis command failures by operation
- `redis_latency_ms` — Redis command latency
- `queue_depth` — current pending background job count
- `job_duration_ms` — job execution time by name and outcome
- `job_failures_total` — terminal job failures by name
- `worker_active_count` — concurrent worker threads
- `dependency_healthy` — boolean gauge per dependency (database, redis)

Trace/request IDs are propagated from API requests into background jobs so that job outcomes can be correlated with the originating request in log queries.

### Recalibrating thresholds from production evidence

Performance budgets are starting points, not permanent guarantees. Recalibrate using this process:

1. **Collect baseline**: After the first production release, collect at least one week of telemetry data covering normal business hours and peak periods.
2. **Identify percentiles**: Extract p50, p95, and p99 for each metric category from the structured log pipeline or metrics dashboard.
3. **Set operational thresholds**: Set warning thresholds at 1.5x the observed p95 and critical thresholds at 2x, unless business requirements dictate tighter bounds.
4. **Document exceptions**: Endpoints with known heavy operations (full inventory export, large date-range reports) may have individual budgets documented here with justification.
5. **Review cadence**: Review budgets quarterly or after significant data growth, schema changes, or feature additions that affect query patterns.
6. **Regression detection**: CI or staging performance checks compare against the documented budgets. When a check fails, the team investigates before merging rather than raising the threshold by default.

### Production-build performance checks

The CI pipeline and staging environment should verify performance budgets:

```bash
# Backend: Run the test suite with telemetry assertions
cd backend && python -m pytest tests/unit/test_telemetry.py -q

# Frontend: production build, then per-route JavaScript budget check
cd frontend && npm run build && npm run perf:bundle

# Frontend: Lighthouse CI against the production server (Core Web Vitals + a11y score)
cd frontend && npm run perf:lighthouse   # reports land in frontend/.lighthouseci

# Frontend: route load timing and axe accessibility scans on desktop + mobile viewports
# (requires a running backend and E2E_USERNAME / E2E_PASSWORD)
cd frontend && npm run e2e:a11y
```

`npm run perf:bundle` is the blocking CI gate: it reads the Next.js build manifests, sums the
gzipped JavaScript each route loads on first paint, and fails the build when a route exceeds its
budget. Lighthouse runs in the `frontend-performance` CI job and uploads its reports as an
artifact. The accessibility and route-timing Playwright projects run in the
`Frontend Playwright E2E` workflow.

When a bundle budget fails, split the offending module with a dynamic import before considering a
budget change. Raise a budget only with a recorded measurement and a note here explaining why the
weight is justified.

Performance checks run against production builds (not development mode) and use representative data volumes. A staging environment with production-like data is preferred for latency validation. Document any environment-specific adjustments (network latency, managed database tier) that affect absolute timing comparisons.

## 11. Dependency-upgrade checklist

For every dependency upgrade:

- Identify whether it is a security, patch, minor, or major upgrade and read the upstream release notes/changelog.
- Check compatibility with Python 3.11, Node 20, Next.js 14, React 18, FastAPI, SQLAlchemy, Alembic, Redis/ARQ, and the deployment images.
- Update the lockfile or pinned requirements deliberately; do not introduce open version ranges or unreviewed transitive changes.
- Run dependency and container vulnerability scans. Record severity, owner, expiry, and compensating controls for any exception; do not permanently waive a finding.
- Run local equivalents of the CI gates: backend tests including Hypothesis tests, frontend lint/type/test/build commands, migration checks, and the Docker build.
- Review authentication, cookie, CORS, logging/redaction, error-tracking, worker, and migration behavior when changing infrastructure libraries.
- Test the upgrade in staging with a production-like database snapshot, health checks, worker jobs, error tracking, and the primary login/ERP smoke flow.
- Confirm backup and rollback readiness before production rollout; for database-related packages, record the expected migration head.
- Merge and deploy the upgrade independently when practical so regressions are attributable, then monitor and document the result.

Current local checks are:

```bash
cd backend && pytest
cd frontend && npm run lint && npx tsc --noEmit && npm test && npm run build
cd backend && docker build -t invenzo-backend:check .
```

Use `npm ci` rather than `npm install` in CI or reproducible release builds. Keep generated build output, `.env` files, database dumps, and secret-manager exports out of commits.

## 12. Database role separation and least privilege

Production deployments MUST use separate database identities for the application, migration, and backup operations. This prevents the running application from executing DDL or accessing backup infrastructure.

### Role structure

| Role | Login User | Purpose | Privileges |
|------|-----------|---------|------------|
| `invenzo_app` | `invenzo_app_user` | Application runtime (Uvicorn) | DML only: SELECT, INSERT, UPDATE, DELETE |
| `invenzo_migrate` | `invenzo_migrate_user` | Alembic migrations (deployment step) | DDL + DML: CREATE, ALTER, DROP, TRUNCATE, all DML |
| `invenzo_backup` | `invenzo_backup_user` | pg_dump backup operations | SELECT only |

### Configuration

```bash
# Application uses a DML-only identity (no DDL capability)
DATABASE_URL=postgresql+asyncpg://invenzo_app_user:<secret>@host:5432/invenzo

# Migration step uses a DDL-capable identity (separate credential)
MIGRATION_DATABASE_URL=postgresql+asyncpg://invenzo_migrate_user:<secret>@host:5432/invenzo
```

The migration runner (`alembic upgrade head`) uses `MIGRATION_DATABASE_URL` when set, falling back to `DATABASE_URL` for backward compatibility in development. In production, these MUST be different credentials with different privilege levels.

### Provisioning

Generate the role SQL from the application code:

```python
from app.services.db_roles import generate_role_sql
print(generate_role_sql(database_name="invenzo"))
```

Execute the generated SQL as a database superuser during initial production setup. Set passwords for each login user via the secret manager—never in the SQL script or source code.

### Development

In development, a single `postgres` user is acceptable. The application logs a warning when role separation is not configured but does not block startup outside production.

## 13. Data retention and deletion policies

### Retention schedule

| Data Category | Retention | Action After Expiry |
|---------------|-----------|---------------------|
| Transaction records (sales, purchases, invoices) | 7 years | Archive to cold storage, then purge |
| Inventory movements (ledger entries) | 7 years | Archive then purge |
| Audit trails | 5 years | Soft-delete, then hard-delete |
| Login history | 1 year | Hard-delete entries older than retention |
| Password reset markers (Redis JTIs) | Token TTL | Auto-expired by Redis |
| Background job records | 30 days | Purge completed/failed entries |
| Application logs | 90 days hot / 1 year cold | Lifecycle policy in log aggregator |
| Database backups (daily) | 30 days | Auto-deleted by storage lifecycle |
| Database backups (pre-release) | 90 days | Auto-deleted by storage lifecycle |
| Personal data (customers) | Active + 2 years after last transaction | Anonymize or delete on request |

### Automated cleanup

Schedule periodic cleanup (e.g., weekly cron or deployment-triggered job):

```sql
-- Remove login history older than 1 year
DELETE FROM login_history WHERE created_at < NOW() - INTERVAL '1 year';

-- Remove completed/failed job metadata older than 30 days
-- (ARQ job results stored in Redis expire via TTL; this covers any DB records)
```

### Personal data deletion

On receiving a data deletion request:
1. Verify requestor identity
2. Anonymize customer PII (replace with `[DELETED]` tokens)
3. Retain financial transaction records with anonymized references
4. Log the deletion in the audit trail
5. Confirm completion to the requestor

See `backend/docs/backup_recovery.md` for the complete retention policy reference.

## 14. Restore verification

### Automated verification

Run restore verification weekly (or after each release cycle) using the provided script:

```bash
# 1. Restore backup into an isolated test database (never production)
pg_restore --dbname="$RESTORE_TEST_DB" --no-owner --clean --if-exists backup.dump

# 2. Run integrity checks
cd backend
python -m scripts.verify_restore --database-url "$RESTORE_TEST_DB"
```

The script checks:
- Alembic revision consistency
- Inventory ledger integrity (no orphan references, no NULL required fields)
- Sales integrity (valid items, non-negative totals)
- Purchase order integrity (valid supplier references)
- Invoice integrity (valid sale references)
- User account integrity (roles, password hashes, timestamps)
- Audit trail integrity (timestamps, action fields)

### Recording results

Each verification produces a report with restore duration, Alembic revision, table counts, and per-check pass/fail. Store reports alongside backup metadata. Alert if a verification fails.

### Quarterly drill

Perform a manual restore drill quarterly with full team participation. Record:
- Actual restore duration vs RTO target
- Any integrity check failures or anomalies
- Lessons learned and process improvements
