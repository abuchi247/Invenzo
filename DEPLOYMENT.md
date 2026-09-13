# Deployment Guide — VPS (Johannesburg)

This guide deploys Invenzo (frontend, backend API, background worker,
PostgreSQL, and Redis) to a single small VPS running the production Docker
Compose stack, with a Caddy reverse proxy for automatic HTTPS. It then covers
migrating data off the old Railway deployment and shutting Railway down.

## Why this setup

- **Location matters most for speed.** Invenzo's users are in West Africa
  (e.g. Nigeria). The closest practical cloud region is **Johannesburg (JNB)**
  in South Africa (~40–70 ms round trip to Lagos) versus ~200–250 ms from US
  regions. A multi-call app feels dramatically snappier the closer the server
  is to the user.
- **One always-on box, low cost.** A ~$6–12/month VPS runs the whole stack with
  no cold starts and no free-tier database expiry.
- **No code changes.** It runs the existing `docker-compose.production.yml`
  unchanged, plus a small Caddy config for TLS.

The tradeoff: you manage the server (OS updates, backups). Budget ~2–4
hours/month. This guide gives you every command.

---

## Prerequisites

- A domain name you control (e.g. `yourdomain.com`). You will point it at the
  VPS. HTTPS certificates are issued automatically by Caddy for that domain.
- A VPS with a **Johannesburg** region. Good options: LightNode, Zappie Host,
  or any provider with a JNB node. Pick at least **2 GB RAM** (4 GB is
  comfortable for Postgres + Redis + three app containers).
- SSH access to the VPS as a sudo-capable user.
- SMTP credentials for password-reset emails (e.g. a transactional email
  provider). Required outside development.

---

## Step 0 — DNS

Decide on your hostnames. This guide uses a single apex domain serving the
frontend, with the API proxied under `/api` on the same domain (simplest, and
it keeps the auth cookie same-site so you can use `REFRESH_COOKIE_SAMESITE=strict`):

- `yourdomain.com` → frontend, and `yourdomain.com/api/v1` → backend.

In your domain registrar's DNS settings, create an **A record**:

| Type | Name | Value |
|------|------|-------|
| A    | `@`  | your VPS public IP |
| A    | `www` (optional) | your VPS public IP |

DNS can take a few minutes to propagate. Verify with `dig yourdomain.com +short`
— it should return your VPS IP before you request certificates.

> **Alternative (split hosts):** if you prefer `app.yourdomain.com` for the
> frontend and `api.yourdomain.com` for the backend, add an A record for each.
> Because those are different sites, you must then set
> `REFRESH_COOKIE_SAMESITE=none` and `REFRESH_COOKIE_SECURE=true` so the refresh
> cookie is sent cross-site. The same-domain layout above avoids that.

---

## Step 1 — Prepare the server

SSH in, then install Docker and the Compose plugin (Ubuntu/Debian shown):

```bash
# System updates
sudo apt-get update && sudo apt-get upgrade -y

# Docker Engine + Compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # log out/in afterwards so docker works without sudo

# Basic firewall: allow SSH + HTTP + HTTPS only
sudo apt-get install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

Log out and back in so your user picks up the `docker` group.

---

## Step 2 — Get the code and configure the environment

```bash
git clone https://github.com/abuchi247/Invenzo.git
cd Invenzo

cp .env.example .env
```

Edit `.env` and set production values. The critical ones:

| Variable | Value |
|----------|-------|
| `ENVIRONMENT` | `production` |
| `POSTGRES_USER` | a database user name |
| `POSTGRES_PASSWORD` | a strong generated password |
| `POSTGRES_DB` | `invenzo` |
| `REDIS_PASSWORD` | a strong generated password (required in production) |
| `SECRET_KEY` | a 32+ byte random secret (see below) |
| `CORS_ORIGINS` | `https://yourdomain.com` |
| `FRONTEND_BASE_URL` | `https://yourdomain.com` |
| `NEXT_PUBLIC_API_URL` | `https://yourdomain.com/api/v1` |
| `REFRESH_COOKIE_SAMESITE` | `strict` (same-domain layout) |
| `SMTP_HOST` / `SMTP_PORT` | your SMTP server |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | your SMTP credentials |
| `SMTP_FROM_EMAIL` | e.g. `no-reply@yourdomain.com` |

Generate strong secrets:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"   # SECRET_KEY
openssl rand -base64 32                                          # passwords
```

> **`NEXT_PUBLIC_API_URL` is baked into the browser bundle at build time.**
> `docker-compose.production.yml` passes it as a build arg to the frontend
> image, so it must be set in `.env` **before** you build. If you change it
> later, rebuild the frontend image (`docker compose -f
> docker-compose.production.yml build frontend`) — a plain restart will not
> pick up the new value.

---

## Step 3 — Add the Caddy reverse proxy

The production compose binds the backend to `127.0.0.1:8000` and the frontend to
`127.0.0.1:3000` (not exposed publicly — TLS terminates at the proxy). Caddy
sits in front, gets HTTPS certificates automatically, serves the frontend, and
proxies `/api/*` to the backend.

Create `Caddyfile` in the repo root:

```caddy
yourdomain.com {
    encode gzip

    # API and auth routes → backend
    @api path /api/* /health
    handle @api {
        reverse_proxy 127.0.0.1:8000
    }

    # Everything else → frontend
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

Install and run Caddy directly on the host (simplest; it manages certificates
and renewal automatically):

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# Use the repo Caddyfile
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy will obtain a Let's Encrypt certificate for `yourdomain.com` the first
time it serves traffic (DNS must already point at this server — see Step 0).

---

## Step 4 — Build and start the stack

```bash
docker compose -f docker-compose.production.yml up -d --build
```

This builds the backend, worker, and frontend images and starts all services
plus the scheduled backup service. On first start with an empty database:

- The backend runs `alembic upgrade head` before serving traffic (via
  `backend/start.sh`), then launches uvicorn with `WEB_CONCURRENCY` workers.
- An initial admin account is auto-provisioned. Get its temporary password:

```bash
docker logs invenzo-backend 2>&1 | grep "Temporary Password"
```

Seed the default categories (safe to rerun; skips if any exist):

```bash
docker exec invenzo-backend python scripts/seed_categories.py
```

---

## Step 5 — Verify

```bash
# Backend health (through Caddy, HTTPS)
curl https://yourdomain.com/health
# → {"status":"healthy", ... database + redis up}
```

Then open `https://yourdomain.com` in a browser, log in as `admin` with the
temporary password from the logs, and complete the forced password change.

Confirm in the backend logs that you see `Starting uvicorn with N worker(s)...`
and no migration errors.

---

## Step 6 — Migrate data off Railway (only if Railway has real data)

If your Railway instance holds real business data you want to keep, migrate it
**before** shutting Railway down. If Railway only has test data, skip this and
start fresh on the VPS.

### 6a. Back up Railway first (do this regardless)

From your laptop (needs the Postgres client tools, e.g. `brew install libpq`):

```bash
# Get the PUBLIC connection string from the Railway dashboard:
#   Postgres service → Connect → Public Network → DATABASE_PUBLIC_URL
pg_dump "postgresql://USER:PASSWORD@HOST:PORT/railway" \
  -Fc -f railway_backup_$(date +%Y%m%d).dump

# Verify the dump is real (lists tables, non-trivial size)
ls -lh railway_backup_*.dump
pg_restore --list railway_backup_*.dump | head -30
```

Keep this file safe. `*.dump` is gitignored, so it will never be committed.

### 6b. Restore into the VPS database

Copy the dump to the server and restore it into the running Postgres container:

```bash
# From your laptop
scp railway_backup_*.dump youruser@YOUR_VPS_IP:~/Invenzo/

# On the VPS — restore into the app database
cat railway_backup_*.dump | docker exec -i invenzo-postgres \
  pg_restore --clean --if-exists --no-owner \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Then run migrations to bring the restored schema up to the current head (safe
if already current):

```bash
docker exec invenzo-backend alembic upgrade head
```

Re-verify `https://yourdomain.com/health` and log in to confirm the data is
present and correct.

---

## Step 7 — Shut down Railway

Only after the VPS is verified working **and** you have the Railway backup file
in hand:

1. In the Railway dashboard, open the project.
2. Remove the frontend, backend, Postgres, and Redis services (or delete the
   whole project).
3. Confirm billing has stopped.

Do not delete the Railway backup dump — keep it archived off-site for a while.

---

## Ongoing operations

### Deploying updates

For customer instances configured under `customers/<slug>/` with project name
`invenzo-<slug>`, use `./scripts/deploy_customer.sh <slug>` as described in the
[Customer deployment guide](DEPLOY_CUSTOMER.md). It coordinates backup,
build, restart, and verification.

The manual commands below apply to this guide's legacy root `.env` deployment.
The customer script deliberately refuses that layout; do not rename its Compose
project to make the script run, because that could select a different database
volume. Take and verify a backup using the operations runbook before updating.


```bash
cd ~/Invenzo
git pull
docker compose -f docker-compose.production.yml up -d --build
```

Migrations run automatically on backend startup. If you changed
`NEXT_PUBLIC_API_URL`, the `--build` step rebuilds the frontend with the new
value.

### Backups

The stack includes a scheduled backup service (`backup-runner` + `ofelia`
scheduler) that runs `pg_dump` daily at 02:00 UTC into the `backup-data`
volume. Run an immediate backup before a risky change:

```bash
docker compose -f docker-compose.production.yml run --rm backup-runner sh /backup.sh
```

Copy dumps off the server periodically (e.g. to object storage). See
[OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) §4 for restore and verification.

### Logs

```bash
docker logs -f invenzo-backend
docker logs -f invenzo-worker
docker logs -f invenzo-frontend
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Browser shows "not secure" / no certificate | DNS must point at the VPS **before** Caddy can issue a cert. Check `dig yourdomain.com +short`, then `sudo systemctl reload caddy`. |
| Frontend loads but API calls fail | Confirm `NEXT_PUBLIC_API_URL` was set in `.env` **before** the frontend was built, and that it matches your domain. Rebuild the frontend if it was wrong: `docker compose -f docker-compose.production.yml build frontend && docker compose -f docker-compose.production.yml up -d`. |
| CORS errors in the browser | `CORS_ORIGINS` must equal your exact frontend origin, e.g. `https://yourdomain.com`. `*` is rejected in production. |
| Login succeeds but immediately logs out | Cross-site cookie issue. Use the same-domain layout (frontend and API on one domain) with `REFRESH_COOKIE_SAMESITE=strict`, or set `REFRESH_COOKIE_SAMESITE=none` + `REFRESH_COOKIE_SECURE=true` for split hosts. |
| Backend container restarts / won't start | Check `docker logs invenzo-backend`. A failed migration stops the container by design rather than serving a partial schema. |
| Emails not sending | SMTP is used by the **worker**, not just the backend. Confirm the SMTP variables are present for the worker too (they share the same `.env`). |
