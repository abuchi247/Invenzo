<div align="center">

<img src="docs/logo.svg" alt="Invenzo logo" width="96" height="96" />

# Invenzo

### Inventory & Sales ERP

</div>

A comprehensive Enterprise Resource Planning system for product-based businesses — inventory, sales, purchasing, and reporting in one place. Built with Python FastAPI, Next.js, PostgreSQL, and Redis.

> Invenzo currently ships with an automotive spare-parts catalogue out of the box. The core (inventory, sales, customers, suppliers, purchasing, transfers, auditing) is business-agnostic and is being generalized to support additional business types.

## Overview

Invenzo digitizes and streamlines operations for product-based businesses, replacing manual spreadsheet and paper-based processes with a modern, scalable ERP solution featuring immutable ledger architecture, FIFO cost management, and snapshot-based auditing.

## Key Capabilities

- **Inventory Management** — Multi-location stock tracking with FIFO cost layers and barcode support
- **Sales Management** — Cash and credit sales with pessimistic locking, automatic COGS calculation, partial payments at checkout, and PDF invoice generation. The sales list filters by status, date range, and product sold (part number or name), and shows who issued each sale.
- **Customer Management** — Credit ledger with limit enforcement, aging analysis, payment tracking linked to specific sales, and partial payment support
- **Supplier Management** — Purchase orders with full lifecycle (draft → approved → received), goods receipt notes, and supplier balance tracking
- **Transfer Management** — Multi-location transfers with in-transit state and cost layer propagation
- **Barcode System** — Code 128 barcode generation, scanning, and lookup
- **Inventory Audits** — Snapshot-based cycle counts and full stock counts with variance tracking
- **Invoice Generation** — PDF invoices in A4 and thermal (80mm) formats with QR codes and barcodes, showing the issuing user and your configurable invoice footer. View inline or download. Supports regeneration to reflect updated business settings. Credit notes generated automatically for returns.
- **Business Settings** — Configurable company profile (name, logo, address, bank details, invoice footer) that populates invoices and reports
- **Reporting & Dashboard** — Sales, inventory, customer, supplier, and financial reports with CSV/PDF export. Dashboard with Top 5 Products and Top 5 Customers widgets filterable by period (month, 3M, 6M, 1Y, all time).
- **Notifications** — Low stock alerts, credit limit warnings, overdue customer reminders, and pending approval notifications
- **Audit Trail** — Append-only, immutable record of all critical system events
- **Security** — Role-based access control (Admin, Manager, Salesperson, Storekeeper) with JWT authentication, rate limiting, sliding-window account lockout (locks after 5 failed logins within 15 minutes for 30 minutes), admin-initiated password reset for users who forget theirs, forced password change on first login, case-insensitive usernames and emails (stored and matched in lowercase, so `John` and `john` are the same account), and optional encrypted-at-rest database backups (AES-256-CBC)

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.11, FastAPI, SQLAlchemy 2.0 (async), Alembic |
| Database | PostgreSQL 15 |
| Cache/Sessions | Redis 7 |
| Frontend | Next.js 14, TypeScript, Tailwind CSS, React Query, Axios |
| Auth | JWT (Access + Refresh Tokens), bcrypt |
| PDF | WeasyPrint |
| Barcode/QR | python-barcode (Code 128), qrcode |
| Rate Limiting | slowapi + Redis |
| Background Jobs | ARQ (async Redis-based task queue) |
| Error Tracking | Sentry |
| Testing (Backend) | pytest (1100+ unit tests), Hypothesis (property-based) |
| Testing (Frontend) | Vitest (48 unit tests), Playwright (E2E + accessibility via axe-core) |
| Deployment | Docker, Docker Compose, VPS + Caddy (automatic HTTPS) |

## Getting Started

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running

### Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/abuchi247/Invenzo.git
   cd Invenzo
   ```

2. **Create environment file**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set your `POSTGRES_PASSWORD` and `SECRET_KEY` values.

3. **Start all services**
   ```bash
   docker-compose up --build
   ```
   This builds and starts all five containers: PostgreSQL, Redis, the FastAPI backend, the ARQ background worker, and the Next.js frontend. The frontend is built inside Docker using the production standalone build — no local Node.js installation required.

4. **Database migrations** run automatically inside the backend container before Uvicorn accepts traffic. To re-run them manually (e.g. after adding migrations):
   ```bash
   docker exec invenzo-backend alembic upgrade head
   ```

5. **Retrieve the initial admin password**. On a fresh database (no users), the backend auto-creates an `admin` account with a random temporary password and prints it to the container logs exactly once:
   ```bash
   docker logs invenzo-backend 2>&1 | grep "Temporary Password"
   ```
   You will see output like:
   ```
     Temporary Password: xK7#mPq2RvLnJ9Ys
   ```
   This password is generated uniquely for each deployment and is never stored in plaintext.

6. **Log in and set your password**. Open http://localhost:3000 and log in with username `admin` and the temporary password from the logs. You will be redirected to a "Set your password" screen where you must choose a new password before accessing the system.

7. **Seed default categories** (optional)
   ```bash
   docker exec invenzo-backend python scripts/seed_categories.py
   ```
   This creates 10 parent categories (Brakes, Filters, Engine Parts, etc.) with 35 subcategories.

8. **Access the application**

   | Service | URL |
   |---------|-----|
   | Frontend (UI) | http://localhost:3000 |
   | Backend API | http://localhost:8000 |
   | Health check | http://localhost:8000/health |
   | API Docs (Swagger) | http://localhost:8000/docs (development only — disabled in production) |

9. **Get your admin password.** On a fresh database the backend auto-creates an `admin` account and prints the temporary password to the container logs exactly once:
   ```bash
   docker logs invenzo-backend 2>&1 | grep "Temporary Password"
   ```
   Log in at http://localhost:3000 with username `admin` and that password. You will be prompted to set a new password before accessing the system.

10. **Restart from scratch** (wipes all data and rebuilds the images):
    ```bash
    docker compose down -v          # stops containers and deletes all volumes
    docker compose up --build -d    # rebuilds images and starts fresh
    docker logs invenzo-backend 2>&1 | grep "Temporary Password"  # get new password
    ```

> **Local development with hot-reload:** if you want live code reloading on the frontend, stop the frontend container (`docker compose stop frontend`) and run `npm run dev` in the `frontend/` directory instead. The backend services stay in Docker.

### Database backups and restore

#### When to run backups

Production runs an automatic PostgreSQL backup every day at **02:00 UTC** when both `backup-runner` and `backup-scheduler` are running. Also run an on-demand backup immediately before:

- Deploying migrations or a major application change
- Deleting or modifying customer, inventory, or financial data
- Restoring a database
- VPS, Docker, PostgreSQL, or other infrastructure maintenance
- Testing a risky operational procedure

An automatic backup is not a substitute for an off-server copy or a restore drill. Copy the backup **and its `.sha256` checksum sidecar** to restricted off-site storage, and periodically verify that a restore succeeds.

#### Local development backup

Results go to `./backups/` on the host. The Compose profile uses the backup service's `sh /backup.sh` entrypoint:

```bash
docker compose --profile backup run --rm backup

docker compose --profile backup run --rm -e BACKUP_LABEL=pre-release backup
```

#### Production deployment verification and on-demand backup

For a customer instance such as `skons`, run this from the repository root after every deployment:

```bash
cd ~/Invenzo
git pull

docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  up -d --build

docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  exec backend alembic current

curl -sS https://skons.invenzo.app/health

docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  ps
```

The migration command must report the expected deployed Alembic head, and `/health` must report a healthy database and Redis before the deployment is considered complete.

Run an on-demand backup against the already-running production runner. Using `exec` is important for encrypted deployments because the runner installs OpenSSL during startup:

```bash
docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  exec backup-runner sh /backup.sh

# Optional label for a pre-release or maintenance backup:
docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  exec -e BACKUP_LABEL=pre-release backup-runner sh /backup.sh

# Confirm the backup and checksum files:
docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  exec backup-runner ls -lh /backups
```

#### Encrypted backups

`BACKUP_ENCRYPTION_KEY` is generated per customer by `scripts/provision_customer.sh`. When set, backups are stored as AES-256-CBC/PBKDF2-encrypted `.dump.enc` files, with a checksum at `.dump.enc.sha256`; the plaintext dump is removed. Store the key in a password manager or secret manager outside the VPS. **Never commit it, print it into ordinary logs, or store it only on the server.** Without the same key, encrypted backups cannot be restored.

For an older production instance that has no key, generate and save the key securely before adding it to that customer's `.env`, then recreate the runner so it receives the variable:

```bash
KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
printf 'BACKUP_ENCRYPTION_KEY=%s\\n' "$KEY" >> customers/skons/.env
# Save $KEY in the password/secret manager before continuing.
unset KEY

docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  up -d --force-recreate backup-runner backup-scheduler
```

Verify the runner log and `/backups` listing before relying on the next scheduled backup:

```bash
docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  logs --tail=50 backup-runner
```

#### Safe restore procedure

A restore is for a recovery event or a restore drill, not a normal deployment step. **Do not restore directly over production first.** Test the backup in a separate database or server whenever possible.

Create a temporary database in the customer PostgreSQL service:

```bash
docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  exec postgres sh -c \\
  'psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE invenzo_restore_test;"'
```

Restore the latest backup through `backup-runner` (that is where `/restore.sh`, `/backups`, OpenSSL, and the encryption key are available):

```bash
docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  exec -e PGDATABASE=invenzo_restore_test backup-runner \\
  sh /restore.sh /backups/latest.dump
```

`restore.sh` verifies the checksum when present, detects `.dump.enc`, decrypts it with `BACKUP_ENCRYPTION_KEY`, restores the custom-format dump, and removes the temporary decrypted file. Legacy plaintext `.dump` backups remain supported. The target database must already exist, and the restore script drops/recreates objects in that target database.

After the drill, remove the temporary database:

```bash
docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  exec postgres sh -c \\
  'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE invenzo_restore_test;"'
```

For an emergency production restore, first take a final on-demand backup, confirm the exact target database and backup filename, obtain explicit approval, and stop application traffic before restoring:

```bash
docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  exec backup-runner sh /backup.sh

docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  stop backend worker frontend

# Replace invenzo and the filename only after confirming both values.
docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  exec -e PGDATABASE=invenzo backup-runner \\
  sh /restore.sh /backups/<confirmed-backup-file.dump.enc>

docker compose --env-file customers/skons/.env \\
  -f docker-compose.production.yml \\
  -f customers/skons/docker-compose.override.yml \\
  up -d backend worker frontend
```

A production restore overwrites current database objects. Confirm the backup checksum, preserve the encryption key, run `alembic current`, check `/health`, and perform critical data checks before reopening traffic. See [OPERATIONS_RUNBOOK.md §4](OPERATIONS_RUNBOOK.md#4-backup-and-restore) for the complete operational procedure.

### Initial Admin Provisioning

The system follows security best practices for initial credentials:

- **No hardcoded passwords** — the initial admin password is a cryptographically random 16-character string generated at first startup.
- **Displayed once** — the password appears in the backend container logs only on the first boot when the users table is empty. It is not shown on subsequent restarts.
- **Forced password change** — the auto-provisioned admin (and all admin-created users) must change their password on first login before accessing any part of the system.
- **Scoped token** — during the password change flow, a short-lived token (10-minute TTL) restricts the user to only the password change endpoint until they set their own credentials.

If you need to create additional users via CLI, they also require a password change on first login by default:

```bash
docker exec invenzo-backend python scripts/create_user.py \
  --username manager --password TempPass1! --role Manager --email manager@example.com
```

To skip the forced password change (e.g., for automated testing), add `--no-force-change`:

```bash
docker exec invenzo-backend python scripts/create_user.py \
  --username testuser --password TestPass1! --role Salesperson --email test@example.com --no-force-change
```

### Production operations

Production deployments must replace every development placeholder, inject credentials through a secret manager, and run the serialized Alembic migration step before enabling traffic. The complete procedure covers required environment variables, secret generation, backups and restore drills, `/health` readiness checks, ARQ worker operation, error tracking, rollback, supported frontend versions, and dependency upgrades:

- [Production Operations Runbook](OPERATIONS_RUNBOOK.md)

The Compose defaults are for local development only. Never commit a populated `.env` file. The initial admin password is unique per deployment and must be changed on first login.

### Default User Roles

| Role | Access |
|------|--------|
| Admin | Full system access including user management |
| Manager | Approvals, reports, operational oversight |
| Salesperson | Sales processing, customer lookup, invoices |
| Storekeeper | Inventory operations, stock counts, transfers |

### Role Permissions Matrix

| Feature | Admin | Manager | Salesperson | Storekeeper |
|---------|:-----:|:-------:|:-----------:|:-----------:|
| User management | ✅ | ❌ | ❌ | ❌ |
| Business settings (update) | ✅ | ❌ | ❌ | ❌ |
| Delete categories/locations | ✅ | ❌ | ❌ | ❌ |
| Reports (all types) | ✅ | ✅ | ❌ | ❌ |
| Supplier management | ✅ | ✅ | ❌ | ❌ |
| Purchase orders | ✅ | ✅ | ❌ | ❌ |
| Approve transfers/audits | ✅ | ✅ | ❌ | ❌ |
| Credit adjustments | ✅ | ✅ | ❌ | ❌ |
| Sales returns | ✅ | ✅ | ❌ | ❌ |
| Delete customers/suppliers | ✅ | ✅ | ❌ | ❌ |
| Create/update categories | ✅ | ✅ | ❌ | ❌ |
| Sales (create/confirm/cancel) | ✅ | ✅ | ✅ | ❌ |
| Customer management | ✅ | ✅ | ✅ | ❌ |
| Record payments | ✅ | ✅ | ✅ | ❌ |
| Generate/download invoices | ✅ | ✅ | ✅ | ❌ |
| Spare parts (create/edit) | ✅ | ✅ | ❌ | ✅ |
| Stock adjustments | ✅ | ✅ | ❌ | ✅ |
| Transfers (create/receive) | ✅ | ✅ | ❌ | ✅ |
| Audits (initiate/count) | ✅ | ✅ | ❌ | ✅ |
| Receive purchase goods | ✅ | ✅ | ❌ | ✅ |
| Barcodes (generate/assign) | ✅ | ✅ | ❌ | ✅ |
| Dashboard (role-filtered) | ✅ | ✅ | ✅ | ✅ |
| Notifications (own) | ✅ | ✅ | ✅ | ✅ |
| View locations/categories/stock | ✅ | ✅ | ✅ | ✅ |

### Notification Routing by Role

Notifications are automatically generated and delivered to specific roles based on the event type:

| Notification Type | Target Roles | Trigger |
|-------------------|-------------|---------|
| Low Stock Alert | Storekeeper, Manager, Admin | Stock falls below minimum level |
| Credit Limit Exceeded | Manager, Admin | Customer balance exceeds credit limit |
| Overdue Customer | Manager, Admin | Customer balance outstanding 90+ days |
| Pending Approval Reminder | Manager, Admin | Transfer or PO pending approval > 24 hours |

Each user sees only their own notifications. Notifications support read/unread status and can be marked individually or in bulk.

## Project Structure

```
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI application factory
│   │   ├── config.py            # Settings (pydantic-settings)
│   │   ├── database.py          # Async SQLAlchemy engine
│   │   ├── health.py            # Readiness/liveness probes
│   │   ├── models/              # SQLAlchemy ORM models
│   │   ├── schemas/             # Pydantic request/response schemas
│   │   ├── services/            # Business logic layer + background jobs (ARQ)
│   │   ├── routers/             # FastAPI route handlers
│   │   ├── middleware/          # Auth, rate limiting, security headers, telemetry
│   │   └── utils/               # FIFO, PDF generation, barcode tools
│   ├── alembic/                 # Database migrations (16 revisions)
│   ├── tests/                   # 1100+ unit + property-based tests
│   ├── scripts/                 # CLI utilities (create_user, seed, setup_db)
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── app/                 # Next.js App Router pages
│   │   ├── components/          # Shared UI components (DataTable, Modal, etc.)
│   │   ├── hooks/               # Custom React hooks (useAuth, useDebouncedValue)
│   │   └── lib/                 # API client, auth, types, validation, reports
│   ├── e2e/                     # Playwright E2E + accessibility tests
│   ├── scripts/                 # Bundle budget checker
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml           # Backend, Worker, Frontend, PostgreSQL, Redis
├── .env.example
├── .github/workflows/           # CI + E2E pipelines
├── OPERATIONS_RUNBOOK.md        # Production deployment guide
└── .kiro/specs/                 # Feature specifications
```

## API Endpoints

| Module | Prefix | Key Endpoints |
|--------|--------|---------------|
| Auth | `/api/v1/auth` | login, refresh, logout, force-change-password, reset-password |
| Users | `/api/v1/users` | CRUD (Admin only) |
| Spare Parts | `/api/v1/spare-parts` | CRUD, search, barcode |
| Stock | `/api/v1/stock` | Locations, movements |
| Sales | `/api/v1/sales` | List (filter by status, date range, product), create, confirm, return |
| Customers | `/api/v1/customers` | CRUD, ledger, aging |
| Credit | `/api/v1/credit` | Payments, adjustments |
| Suppliers | `/api/v1/suppliers` | CRUD, balance, aging |
| Purchases | `/api/v1/purchase-orders` | Create, approve, receive, cancel |
| Transfers | `/api/v1/transfers` | Create, approve, receive |
| Audits | `/api/v1/audits` | Initiate, counts, approve, reconciliation |
| Reports | `/api/v1/reports` | Sales, inventory, customers, suppliers, financial |
| Dashboard | `/api/v1/dashboard` | KPI widgets |
| Invoices | `/api/v1/invoices` | Generate, download PDF |
| Business Settings | `/api/v1/business-settings` | Get, update company profile |
| Notifications | `/api/v1/notifications` | List, mark read |
| Barcodes | `/api/v1/barcodes` | Lookup, decode |

## Creating Users

This is an internal ERP system — there's no public signup. Admins create user accounts via the Settings page or the CLI script. All newly created users must change their password on first login.

### Using the CLI script

```bash
# Create an admin (will be required to set own password on first login)
docker exec invenzo-backend python scripts/create_user.py \
  --username admin --password TempAdmin1! --role Admin --email admin@example.com

# Create a manager
docker exec invenzo-backend python scripts/create_user.py \
  -u manager -p TempMgr1! -r Manager -e manager@example.com

# Create a salesperson
docker exec invenzo-backend python scripts/create_user.py \
  -u sales1 -p TempSales1! -r Salesperson -e sales@example.com

# Create a storekeeper
docker exec invenzo-backend python scripts/create_user.py \
  -u store1 -p TempStore1! -r Storekeeper -e store@example.com

# Skip forced password change (for testing/automation only)
docker exec invenzo-backend python scripts/create_user.py \
  -u testuser -p TestPass1! -r Salesperson -e test@example.com --no-force-change
```

**Password requirements:** minimum 8 characters, at least one uppercase letter, one lowercase letter, and one digit.

**Usernames and emails are case-insensitive.** They are trimmed and stored in lowercase, and login and password reset match the same way — so `John`, `JOHN`, and `john` are the same account, and a user can sign in regardless of the casing they type. This applies to the API, the CLI script, and existing data (normalized by migration `0015`). Passwords remain case-sensitive.

**Available roles:** `Admin`, `Manager`, `Salesperson`, `Storekeeper`

**First login behavior:** By default, all CLI-created users must change their password on first login. The temporary password provided in the `--password` flag is only used for the initial authentication — the user immediately sets their own password. Use `--no-force-change` to skip this requirement (not recommended for production).

## Deployment

Invenzo deploys as a self-contained Docker Compose stack (backend API, ARQ worker, frontend, PostgreSQL, Redis) behind a Caddy reverse proxy that terminates HTTPS automatically.

### How it's hosted

Invenzo is **single-tenant**: one running stack serves one business, with its own isolated database, Redis, secrets, and daily backups. Multiple businesses run as separate instances on the same server, each reached at its own subdomain.

- **Product domain:** `invenzo.app`
- **Per-customer subdomain:** each business is served at `<slug>.invenzo.app` (e.g. `bro.invenzo.app`)
- **Host:** a single small VPS (Hetzner Cloud, CX23 — 2 vCPU / 4 GB, ~$6.50/month). Region chosen for latency to your users (e.g. a EU region such as Helsinki is closest of the available sites to West Africa; US East for US users)
- **Onboarding a new business:** run `scripts/provision_customer.sh <slug> invenzo.app`, which generates that instance's `.env`, per-instance Docker Compose override, and Caddy vhost with fresh secrets and unique ports — no application code changes and no DNS changes (a wildcard `*.invenzo.app` record covers every subdomain).

> **Why one instance per customer:** complete data isolation (a bug can never leak one business's data to another), trivial per-customer backup/restore and deletion, and zero shared state. Several small stacks fit comfortably on one 4 GB box; move a customer to its own VPS whenever it needs more headroom.

### Deploy runbooks

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the big picture: architecture diagrams, the decisions behind the deployment (tenancy, hosting, DNS, HTTPS), and a one-page customer-onboarding quick reference + checklist. Start here to understand how the whole thing fits together.
- **[DEPLOY_HETZNER.md](DEPLOY_HETZNER.md)** — the primary, current runbook. Full first-server setup on Hetzner (SSH, wildcard DNS for `invenzo.app`, Docker, Caddy, firewall), deploying the first customer instance, and a reusable "add a new customer" section for onboarding customer #2 and beyond in ~15 minutes.
- **[DEPLOYMENT.md](DEPLOYMENT.md)** — alternate single-instance runbook for a Johannesburg VPS (lowest latency for West-African users), including data migration off Railway.

Whichever runbook you follow, the shape is the same:

1. Provision a small VPS and point your domain's DNS (a wildcard `*` A record for the subdomain-per-customer model) at its IP.
2. Install Docker + the Compose plugin and Caddy, then clone this repo.
3. Generate the instance config (`scripts/provision_customer.sh`) and bring the stack up behind Caddy for automatic TLS.
4. Migrations run automatically on backend startup (`backend/start.sh` runs `alembic upgrade head`, then launches uvicorn with `WEB_CONCURRENCY` workers). Grab the initial admin's temporary password from the backend logs (search for `Temporary Password`).

> **Why a small always-on VPS over a free PaaS tier:** free tiers sleep after inactivity (~30s cold starts) and often place servers far from your users, both of which hurt the experience for a real business. A small always-on VPS close to your users is faster and more predictable.

## First-Time Configuration

After initial setup, an Admin should configure the business profile so that invoices display the correct company information.

1. Log in as Admin
2. Go to **Settings** → **Business Profile**
3. Fill in:
   - Business name
   - Phone, email, address
   - Tax ID
   - Upload a business logo (PNG/JPEG, max 500KB — resized automatically for invoices)
   - Bank details (shown on invoices for payment instructions)
   - Invoice footer text
4. Click **Save Business Settings**

This information appears on all generated invoices. To update it later, change the settings and click **Regenerate** on any existing invoice to re-render it with the new details.

## Running Tests

### Backend Tests

```bash
# Run all backend tests (1100+ unit tests)
docker exec invenzo-backend pytest

# Run with verbose output
docker exec invenzo-backend pytest -v

# Run specific test file
docker exec invenzo-backend pytest tests/unit/test_sales_service.py

# Run locally (requires system Python with deps installed)
cd backend && pytest --tb=short -q
```

### Frontend Tests

```bash
# Unit tests (Vitest — 48 tests across 14 files)
cd frontend && npm run test

# Type checking
cd frontend && npx tsc --noEmit

# Lint
cd frontend && npm run lint

# Bundle size budget check
cd frontend && npm run perf:bundle

# End-to-end tests (Playwright — requires running backend + frontend, and a user
# with --no-force-change so Playwright can log in directly)
cd frontend && E2E_USERNAME=testuser E2E_PASSWORD='TestPass1!' npm run e2e

# Accessibility audit via Lighthouse
cd frontend && npm run perf:lighthouse
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_USER` | `postgres` | PostgreSQL username |
| `POSTGRES_PASSWORD` | — | PostgreSQL password |
| `POSTGRES_DB` | `invenzo` | Database name |
| `DATABASE_URL` | (derived) | Full async connection string (auto-built from above if not set) |
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection URL for caching and sessions |
| `JWT_SECRET_KEY` | — | JWT signing secret (min 32 chars in production) |
| `JWT_ACCESS_TOKEN_EXPIRE_MINUTES` | `30` | Access token TTL |
| `JWT_REFRESH_TOKEN_EXPIRE_DAYS` | `7` | Refresh token TTL |
| `CORS_ORIGINS` | `["http://localhost:3000"]` | Allowed CORS origins (JSON array) |
| `ENVIRONMENT` | `development` | `development`, `staging`, or `production` |
| `SENTRY_DSN` | — | Sentry error tracking DSN (optional, enabled in production) |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000/api/v1` | Backend URL for frontend (must include /api/v1) |
| `BACKUP_ENCRYPTION_KEY` | — | Optional passphrase; when set, database backups are encrypted at rest (AES-256-CBC). Keep it safe — required to restore. |
| `DATABASE_POOL_SIZE` | `5` | SQLAlchemy pool size per worker process (kept small so multiple stacks fit under Postgres `max_connections`) |

## Scale Targets

- 1,000–10,000 spare parts catalog
- Multiple warehouse/store locations
- 5–20 concurrent users
- 20–100 sales transactions per day
- 100,000+ historical sales records
- Multi-year transaction retention (7+ year audit trail)

## License

Private — All rights reserved.

## Frontend end-to-end tests

The Playwright suite covers browser login and creation/cancellation of an isolated draft sale. It creates a unique location, spare part, and stock adjustment through the authenticated API, then removes the fixture records after the test; it does not use shared production data.

Create a dedicated test user first (bypassing the forced password change so Playwright can log in directly):

```bash
docker exec invenzo-backend python scripts/create_user.py \
  -u testuser -p TestPass1! -r Salesperson -e test@example.com --no-force-change
```

Then install dependencies and run the suite:

```bash
npm ci
npx playwright install chromium
npm run build
E2E_USERNAME=testuser E2E_PASSWORD='TestPass1!' npm run e2e
```

The API must be available at `E2E_API_URL` (default `http://127.0.0.1:8000/api/v1`) and the frontend at `PLAYWRIGHT_BASE_URL` (default `http://127.0.0.1:3000`). Set `PLAYWRIGHT_SKIP_WEBSERVER=true` when an already-running frontend should be reused. CI supplies `E2E_USERNAME` and `E2E_PASSWORD` through encrypted repository secrets and starts disposable PostgreSQL, Redis, and backend services before running the suite. The CI workflow is `.github/workflows/frontend-e2e.yml`.
