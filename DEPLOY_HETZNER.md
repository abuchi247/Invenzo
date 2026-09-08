# Deploy Invenzo on a Hetzner VPS (product domain, subdomain per customer)

This is the cheap, practical path to run Invenzo for real customers. It uses
one small Hetzner VPS, a single product domain you own (e.g. `invenzo.app`),
and **one isolated instance per customer** served at `<customer>.invenzo.app`.

Invenzo is single-tenant — one running stack is one business with its own
database. This runbook deploys the first customer (your brother's business) and
then shows how to add each new customer in ~15 minutes with
`scripts/provision_customer.sh`.

> **Why one instance per customer:** complete data isolation (a bug can never
> leak one business's data to another), trivial per-customer backup/restore and
> deletion, and zero application code changes. The tradeoff is you run several
> small stacks. Several fit comfortably on one 4 GB box; move a customer to its
> own VPS whenever you want stronger isolation or more headroom.

---

## What you need before starting

1. **A domain you own** (e.g. `invenzo.app`). Register at Cloudflare,
   Porkbun, or Namecheap (~$10/year). Customers get subdomains of it.
2. **A Hetzner Cloud account** — https://www.hetzner.com/cloud
3. **An SSH key** on your Mac. Check with `cat ~/.ssh/id_ed25519.pub`; if you
   have none, run `ssh-keygen -t ed25519` first.
4. **(Recommended) SMTP credentials** for password-reset emails — the
   **Brevo free tier** (300 emails/day, no card) is the default this runbook
   uses; see the Brevo setup box below. The app boots without SMTP and
   admin-driven password reset (Settings → Reset password) still works, so you
   can deploy first and add SMTP later — only the emailed self-service reset
   needs it.

> **Brevo free SMTP (do this once, reuse for every customer):**
> 1. Sign up at https://www.brevo.com — stay on the **Free** plan (skip/close
>    any paid-plan upsell; your account is already free).
> 2. **Senders, domains, IPs** → add and verify a sender email you control
>    (Brevo emails a confirmation link). Later, verify your domain to send as
>    `no-reply@yourdomain.com`.
> 3. **Settings → SMTP & API → SMTP** tab. Note the **Login** (looks like
>    `1a2b3c001@smtp-brevo.com`) and click **Generate SMTP key** — copy the key
>    (shown once). Server is `smtp-relay.brevo.com`, port `587`.
> 4. You'll paste the Login as `SMTP_USERNAME` and the key as `SMTP_PASSWORD`
>    into each customer's `.env` (Step 6b). The host/port/TLS are pre-filled.
>
> **Important — the From address must be verified in Brevo.** Brevo rejects any
> email whose `From:` (`SMTP_FROM_EMAIL`) is a sender/domain you haven't
> verified. Fastest path: verify a sender you control (e.g. your Gmail) and set
> `SMTP_FROM_EMAIL` to it. For a branded `no-reply@invenzo.app`, verify the
> `invenzo.app` **domain** in Brevo (add the DKIM/DMARC DNS records it gives you
> at Cloudflare) first. Until then, password-reset emails will fail to send —
> though admin-driven password reset in Settings works regardless.

---

## Step 1 — Create the VPS (Hetzner)

1. Sign in at https://www.hetzner.com/cloud → **New Project** → **Add Server**.
2. **Location:** choose the region closest to your users. Hetzner has no Africa
   datacenter, so for West-African (e.g. Nigerian) users an **EU region such as
   Helsinki** is the closest of the available sites (~100–150 ms to Lagos vs
   ~200 ms+ from US East). Pick **Ashburn, VA (US East)** instead if your users
   are in the US. Location does not change the price — the server type does.
3. **Image:** Ubuntu 24.04 LTS. (Avoid non-LTS/newer images — this runbook is
   tested against 24.04.)
4. **Type:** on the **Shared vCPU** tab, the **Cost-Optimized / CX** line is the
   cheapest. Pick **CX23** (2 vCPU / 4 GB / 40 GB, ~€6.49/mo). 4 GB is the
   comfortable minimum for the whole stack; don't go below it. (Note: the
   `CPX`/"Regular Performance" line is a pricier tier — `CX` is the one you want.)
5. **SSH key:** add your public key (`cat ~/.ssh/id_ed25519.pub`).
6. Create the server and note its **public IPv4 address**.

> **Tip — SSH config:** add an entry to `~/.ssh/config` so you can just
> `ssh invenzo`:
> ```
> Host invenzo
>     HostName <your server IPv4>
>     User root
>     IdentityFile ~/.ssh/id_ed25519
> ```

---

## Step 2 — Point your domain at the server (DNS)

In your domain registrar's DNS settings, add records so every customer
subdomain resolves to this server. A **wildcard** record is simplest:

| Type | Name  | Value                |
|------|-------|----------------------|
| A    | `*`   | your server's IPv4   |
| A    | `@`   | your server's IPv4   |

The `*` record means any `<anything>.invenzo.app` points at this box, so you
never touch DNS again when adding a customer. Verify (can take a few minutes):

```bash
dig bro.invenzo.app +short    # should print the server IP
```

---

## Step 3 — Prepare the server

SSH in as root (or a sudo user) and install Docker + a firewall:

```bash
ssh root@YOUR_SERVER_IP

# System updates
apt-get update && apt-get upgrade -y

# Docker Engine + Compose plugin
curl -fsSL https://get.docker.com | sh

# Firewall: allow only SSH, HTTP, HTTPS
apt-get install -y ufw
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

---

## Step 4 — Get the code

```bash
git clone https://github.com/abuchi247/Invenzo.git
cd Invenzo
```

Everything below runs from this `~/Invenzo` directory.

---

## Step 5 — Install Caddy (automatic HTTPS reverse proxy)

Caddy sits in front of every customer instance, terminates HTTPS (issuing
Let's Encrypt certificates automatically per subdomain), and routes each
subdomain to that customer's containers.

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

Caddy starts with an empty site config; you add one vhost block per customer in
the next step.

> **Note on certificates:** this runbook uses per-subdomain certificates issued
> over the HTTP challenge — no DNS API token needed, and each `provision`
> generates the right vhost block. (If you ever want a single wildcard
> certificate for `*.invenzo.app` instead, that requires Caddy's DNS
> challenge and a registrar API token — more setup, not needed here.)

---

## Step 6 — Provision and deploy the first customer (your brother)

Pick a short, DNS-safe slug for the business (lowercase letters, digits,
hyphens), e.g. `bro`. Then generate its config:

```bash
# scripts/provision_customer.sh <slug> <domain> [smtp_host] [smtp_from_email]
# SMTP host defaults to Brevo (smtp-relay.brevo.com); pass args only to override.
./scripts/provision_customer.sh bro invenzo.app
```

This creates `customers/bro/` with a `.env` (fresh secrets), a compose override,
a `Caddyfile.snippet`, and a `README.md`. Nothing has started yet.

**6a. Add the customer to Caddy:**

```bash
cat customers/bro/Caddyfile.snippet | sudo tee -a /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**6b. (If you have Brevo SMTP)** edit `customers/bro/.env` and paste your Brevo
values: `SMTP_USERNAME` = the Brevo **Login** (e.g. `1a2b3c001@smtp-brevo.com`),
`SMTP_PASSWORD` = the **SMTP key** you generated, and set `SMTP_FROM_EMAIL` to a
sender you verified in Brevo. Host/port/TLS are pre-filled to Brevo's relay.
Skip this if deploying without email for now.

**6c. Bring the stack up** (builds images the first time; subsequent customers
reuse the cached images and start in seconds):

```bash
docker compose --env-file customers/bro/.env \
  -f docker-compose.production.yml \
  -f customers/bro/docker-compose.override.yml \
  up -d --build
```

On first start the backend runs database migrations, then an initial admin
account is auto-provisioned. Get its one-time temporary password:

```bash
docker compose --env-file customers/bro/.env \
  -f docker-compose.production.yml \
  -f customers/bro/docker-compose.override.yml \
  logs backend 2>&1 | grep "Temporary Password"
```

**6d. (Optional) seed the default spare-parts categories:**

```bash
docker compose --env-file customers/bro/.env \
  -f docker-compose.production.yml \
  -f customers/bro/docker-compose.override.yml \
  exec backend python scripts/seed_categories.py
```

---

## Step 7 — Verify

```bash
curl https://bro.invenzo.app/health
# → {"status":"healthy", ... database + redis "up"}
```

Then open **https://bro.invenzo.app** in a browser, log in as `admin` with
the temporary password from Step 6c, and set a new password when prompted. Have
your brother start testing.

---

## Adding a new customer instance (customer #2, #3, …)

Once the server and Caddy are set up (Steps 1–5 are one-time), each new customer
is the same three moves. With the wildcard DNS record from Step 2, you don't
even touch DNS.

```bash
cd ~/Invenzo
git pull    # make sure you're on the latest code

# 1. Generate the instance (choose a unique slug; SMTP host defaults to Brevo)
./scripts/provision_customer.sh acme invenzo.app

# 2. Add its Caddy vhost and reload
cat customers/acme/Caddyfile.snippet | sudo tee -a /etc/caddy/Caddyfile
sudo systemctl reload caddy

# 3. (optional) set SMTP_USERNAME/SMTP_PASSWORD in customers/acme/.env, then start it
docker compose --env-file customers/acme/.env \
  -f docker-compose.production.yml \
  -f customers/acme/docker-compose.override.yml \
  up -d --build

# Grab the admin temp password
docker compose --env-file customers/acme/.env \
  -f docker-compose.production.yml \
  -f customers/acme/docker-compose.override.yml \
  logs backend 2>&1 | grep "Temporary Password"
```

Each instance:
- gets its own database, Redis, secrets, and daily backups (fully isolated);
- is namespaced by `COMPOSE_PROJECT_NAME=invenzo-<slug>` so containers,
  volumes, and networks never collide;
- publishes on unique loopback ports (derived from the slug) that Caddy proxies.

**Capacity guidance:** a 4 GB CX23 comfortably runs 2–3 small instances. Watch
`docker stats` and free memory; when the box gets tight, either resize the
Hetzner server up a tier or move a customer to its own VPS (provision on the
new box, restore that customer's DB dump — see OPERATIONS_RUNBOOK.md §4).

---

## Operating the instances

**Update every customer to the latest code:**

```bash
cd ~/Invenzo
git pull
for d in customers/*/; do
  slug="$(basename "$d")"
  echo "Updating $slug..."
  docker compose --env-file "customers/$slug/.env" \
    -f docker-compose.production.yml \
    -f "customers/$slug/docker-compose.override.yml" \
    up -d --build
done
```

Migrations run automatically on each backend start. If you changed
`NEXT_PUBLIC_API_URL` for an instance, the `--build` rebuilds its frontend.

**On-demand backup before a risky change** (per customer):

```bash
docker compose --env-file customers/bro/.env \
  -f docker-compose.production.yml \
  -f customers/bro/docker-compose.override.yml \
  run --rm backup-runner sh /backup.sh
```

Each instance also runs a scheduled daily backup into its own `backup-data`
volume. Copy those dumps off the server periodically (object storage). See
[OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) §4 for restore and off-site
storage.

> **Encrypted backups:** `provision_customer.sh` generates a per-customer
> `BACKUP_ENCRYPTION_KEY` in each `.env`, so dumps are encrypted at rest
> (AES-256-CBC) as `.dump.enc` files. `restore.sh` auto-decrypts them using
> the same key. **Keep each customer's `.env` (and that key) backed up
> somewhere safe — without the key its encrypted backups cannot be restored.**
> Instances provisioned before this feature won't have the key; add
> `BACKUP_ENCRYPTION_KEY=<random>` to their `.env` and re-bring-up to enable it.

**Logs / status for one customer:**

```bash
docker compose --env-file customers/bro/.env \
  -f docker-compose.production.yml \
  -f customers/bro/docker-compose.override.yml \
  ps

docker compose --env-file customers/bro/.env \
  -f docker-compose.production.yml \
  -f customers/bro/docker-compose.override.yml \
  logs -f backend
```

**Remove a customer instance** (stops containers and deletes their data — be
sure you have a final backup first):

```bash
docker compose --env-file customers/bro/.env \
  -f docker-compose.production.yml \
  -f customers/bro/docker-compose.override.yml \
  down -v
# then remove its Caddy block from /etc/caddy/Caddyfile and reload caddy,
# and delete customers/bro/
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Browser shows no certificate / "not secure" | DNS for the subdomain must resolve to this server **before** Caddy can issue a cert. `dig <slug>.<domain> +short`, then `sudo systemctl reload caddy`. |
| Backend container keeps restarting | `docker compose ... logs backend`. A failed migration or a placeholder/invalid production setting stops the container by design. The provision script writes valid secrets; the likely culprit is an SMTP or URL value you edited. |
| API calls fail / CORS errors | `CORS_ORIGINS` and `NEXT_PUBLIC_API_URL` in that customer's `.env` must match `https://<slug>.<domain>`. If you changed the domain after first build, re-run the up command with `--build` to rebuild the frontend. |
| Login works then immediately logs out | Same-domain layout expects `REFRESH_COOKIE_SAMESITE=strict` (the provision script sets this). Don't split frontend/API across different domains without switching to `SAMESITE=none` + Secure. |
| Password-reset emails not arriving | SMTP is used by the **worker**. Ensure `SMTP_*` are set in that customer's `.env` and re-run the up command. |
| Out of memory / containers killed | Too many instances on the box. `docker stats`, then resize the VPS up a tier or move a customer to its own server. |
