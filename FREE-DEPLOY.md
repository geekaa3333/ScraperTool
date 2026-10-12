# Free-tier deployment — Oracle Cloud Always Free

Target bill: **$0/month.** Nothing here provisions a paid resource, and nothing
here upgrades an account.

---

## Verified before writing this

**Oracle's current free allowance is 2 OCPU / 12 GB, not 4 / 24.** Oracle halved
the Always Free Ampere A1 allowance during 2026. The architecture below is sized
for 2 OCPU / 12 GB. If you find a blog saying 4 OCPU / 24 GB, it is out of date.

**The Playwright base image is genuinely multi-arch.** Checked against the
registry, not assumed:

```
mcr.microsoft.com/playwright:v1.64.0-jammy
  -> linux/amd64, linux/arm64
```

So one image serves Oracle's Ampere A1 and any x86 host.

**A real deployment bug was found and fixed while auditing.** `package.json` pins
`playwright ^1.64.0`, whose driver expects Chromium **revision 1248** — but both
Dockerfiles were pinned to `v1.48.2-jammy`, which ships a much older browser.
That mismatch makes Chromium fail to launch in the container. Both files are now
pinned to `v1.64.0-jammy`, matching the driver.

**ARM64 dependency audit:**

| Dependency | ARM64 status |
|---|---|
| `playwright` + Chromium | multi-arch image, verified above |
| `better-sqlite3` | publishes linux-arm64 prebuilds; falls back to source build if none matches. Its build path needs python3/make/g++, which the Playwright base image already has |
| `postgres:16-alpine` | official multi-arch image |
| `caddy:2-alpine` | official multi-arch image |

**Not verified:** no ARM64 machine was available here, so Chromium launch on ARM64
is *not* claimed as tested. It is a published multi-arch image carrying the exact
browser build the driver expects, which is the strongest available evidence short
of running it. The first `docker compose up` is the real test.

---

## What needs YOUR authorization

Oracle requires account creation, and it requires **card verification**. The card
is not charged while you stay inside the free allowances — but Oracle will
attempt a small verification charge, and an inactive free account can be
reclaimed. These are account-level steps only you can take:

1. **Create the account** at <https://signup.cloud.oracle.com/> — use the email
   you want associated with the deployment. Choose a home region.
2. **Complete card verification.** Note: a brand-new account is usually a
   **PAYG account with a $300 trial credit**. That is *not* the same as Always
   Free. You must switch the tenancy to the free shape:
   - Account/Billing → **Billing and Cost Management**
   - Remove or disable the PAYG upgrade so the tenancy cannot exceed free usage
   - Confirm no payment method remains active
3. **Create the VM:** Compute → Instances → Create:
   - Image: Oracle Linux 9 (aarch64) or Ubuntu 24.04 (aarch64)
   - Shape: **VM.Standard.A1.Flex**
   - OCPU: **2**, Memory: **12 GB**
   - Boot volume: ~50 GB
   - **Assign a public IPv4 address**
4. **Open inbound 80 and 443** in the VCN security list. Do not open 5432 —
   Postgres is reachable only inside the Docker network.

**Capacity caveat:** free ARM capacity is frequently unavailable in popular
regions. If the A1 shape cannot be created in your region, stop — do not switch to
a paid shape. Try a less busy region, or wait and retry. A paid fallback is
exactly what this plan is designed to avoid.

---

## After you have a VM

```bash
ssh opc@<your-vm-ip>
```

### 1. Install Docker (the official convenience script)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

### 2. Deploy the code

```bash
sudo mkdir -p /opt/sellerctrl && sudo chown $USER /opt/sellerctrl
git clone <your-private-github-repo> /opt/sellerctrl
cd /opt/sellerctrl

cp .env.production.example .env
```

Generate the two secrets and put them in `.env` — never in chat, never in git:

```bash
openssl rand -base64 24   # POSTGRES_PASSWORD
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # SESSION_SECRET
chmod 600 .env
```

### 3. Start the stack

```bash
docker compose up -d --build
docker compose ps          # all four should be up/healthy
curl -fsS http://127.0.0.1/api/health
```

### 4. Get a free stable hostname

A bare IP cannot get a trusted certificate, and a tunnel URL is temporary, so
neither is acceptable as the production origin. Use **DuckDNS** — a genuinely
free, stable subdomain:

1. Sign in at <https://www.duckdns.org> with the same email as the VM
2. Create a subdomain, e.g. `sellerctrl`
3. Copy the token into `.env` as `DUCKDNS_TOKEN`
4. Point the record at the VM's public IP
5. Set `HOSTNAME=sellerctrl.duckdns.org` in `.env`

Caddy uses the token for a DNS-01 challenge and obtains a real Let's Encrypt
certificate. Test against staging first by uncommenting `acme_ca` in the
`Caddyfile`, then remove it once the real certificate issues.

### 5. Point the Netlify frontend at it

From your own machine:

```bash
cd "/home/geekaa3333/Documents/Default Project/amazon-scraper-mcp"
BACKEND_URL=https://sellerctrl.duckdns.org npm run deploy:netlify
```

Netlify does **not** substitute `${BACKEND_URL}` into redirect rules — that was
verified against your live site — which is why this command regenerates
`netlify.toml` before deploying.

### 6. Keep it running

```bash
sudo systemctl enable --now docker
sudo crontab -e     # add the backup line from scripts/backup.sh
./scripts/check-free-tier.sh    # run this weekly
```

---

## Watching the $0 line

`scripts/check-free-tier.sh` reports CPU, RAM, disk, container memory and volume
usage, and warns if anything crosses the free ceilings. Run it weekly.

The main risks of a surprise bill:

- **VM shape larger than 2/12** — create it at exactly the free size.
- **Boot volume enlarged** — 50 GB is ample; free block storage allowances are
  modest.
- **A public IP with no always-free allowance attached** — Oracle's public IPv4
  is free on the Always Free tier; do not attach premium traffic.
- **Outbound data** — covered by the always-free monthly allowance for the VM.
- **A paid upgrade left active** from signup — remove it. This is the one people
  miss.

---

## Reports and storage

Reports go to `apidata` volume (`/app/data/reports`) by default, which survives a
rebuild. Oracle Always Free Object Storage has a small free quota; set the `S3_*`
variables in `.env` to use it. Either way the bucket/private directory stays
private — downloads go through the authenticated, ownership-checked API.

`REPORT_RETENTION_DAYS=0` keeps everything. **Reports are never deleted
automatically** unless you set that explicitly.

Backups: `scripts/backup.sh` dumps PostgreSQL and the report volume nightly,
keeping 7 daily and 4 weekly. Restore instructions are printed on every run.

---

## Cost control summary

| Item | Cost |
|---|---|
| Netlify Free frontend | $0 |
| Oracle Always Free 2 OCPU / 12 GB VM | $0 |
| PostgreSQL on that VM | $0 |
| Caddy + Let's Encrypt certificate | $0 |
| DuckDNS hostname | $0 |
| Backups on the VM volume | $0 |
| Oracle Object Storage (optional, within free quota) | $0 |

**Only cost risk is account misconfiguration at signup.** Verify the tenancy is
not on PAYG before creating the VM.

---

## What is not claimed

No VM has been created, nothing has been deployed, and no ARM64 Chromium launch
has been observed. The Docker images have not been built — there is no Docker on
this machine. Every "verified" claim above is either a registry check or an
official documentation check, and is labelled as such.