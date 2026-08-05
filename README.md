# sirony-connect

Privacy-first social connection platform. Standalone Docker project, deployed
alongside the other `sirony-*` projects on the Hostinger VPS
(Ubuntu 24.04, Mumbai), served at **connect.sirony.in**.

## Status

Live at **https://connect.sirony.in**.

Built and deployed:

- adult-gated accounts, scrypt passwords, hashed session tokens
- purpose-separated profiles (dating / friends / activities / networking)
  with per-profile visibility, defaulting to invisible
- curated daily introductions, presented as a swipe deck
- mutual matching, a 24-hour opening window, one extension, backtrack
- messaging with per-conversation disappearing messages
- photos with signed short-lived tickets, per-viewer watermark text,
  one-time view, and a retention sweeper
- stories (24h) and reels (30d); reels and story video are YouTube links,
  never uploads
- private hearts and follower counts, QR connect
- clubs, events, compatibility radar
- moderation console with triage, enforcement and appeals
- E2E secret chat — **not security reviewed**, see `src/routes/secret.ts`
- per-type consent, data export, pause and delete

Not built: ID/liveness verification (needs a KYC vendor), voice lounges,
video calls, AI coaching, Couple Mode.

## Topology

Two containers, matching the pattern used by the sibling `sirony-*` projects:

| Service | Image             | Exposure                                  |
| ------- | ----------------- | ----------------------------------------- |
| `app`   | built from source | `127.0.0.1:8300` only — never `0.0.0.0`   |
| `db`    | `postgres:17`     | internal network only, no host port       |

TLS terminates at host nginx, which proxies `connect.sirony.in` to the
loopback port. See [`deploy/nginx/`](deploy/nginx/).

## URLs

| Context | URL |
| ------- | --- |
| Public  | **https://connect.sirony.in** |
| Internal bind | `127.0.0.1:8300` — nginx proxies the domain to this |

`127.0.0.1:8300` is never browsed directly in production. It is deliberately
loopback-only: binding `0.0.0.0` would expose the app to the internet without
TLS. Change it only in `HOST_PORT`, and update the nginx vhost to match.

To reach the app at `connect.sirony.in` on your own machine while developing,
point the hostname at localhost — DNS resolves it to the VPS otherwise:

```bash
echo "127.0.0.1 connect.sirony.in" | sudo tee -a /etc/hosts
```

## Local run

```bash
cp .env.example .env          # then set POSTGRES_PASSWORD
docker compose up --build
curl http://127.0.0.1:8300/healthz
```

## Deploy

Two routes. Both end with the same nginx + certbot step.

### A — SSH (build on the server)

```bash
./deploy/deploy.sh
```

Generates `.env` with a random password on the server, checks the port is
free, builds, starts, and waits for `/readyz`. Idempotent.

### B — Hostinger Docker panel (pull a published image)

The panel **cannot build from source**, so `docker-compose.yml` will not work
there. Use `docker-compose.hostinger.yml`, which pulls a pre-built image.

1. Push this repo to GitHub — `.github/workflows/publish.yml` builds and
   pushes `ghcr.io/<owner>/sirony-connect:latest` on every push to `main`
2. Make the GHCR package public, or add registry credentials in the panel
3. Docker projects → Compose → paste `docker-compose.hostinger.yml`
4. Replace every `REPLACE_ME` first — image owner and database password
5. Name the project `sirony-connect`

Route B works even while direct SSH is unavailable, since the panel goes
through Hostinger's control plane.

Note: the panel variant does not mount `db/migrations/`, having no local
files. Once a schema exists it must be baked into the image or applied by the
app on startup.

### Then, for public access

DNS: `connect.sirony.in` → `147.93.107.173` (already in place).

Install the nginx vhost and obtain a certificate — commands are in the header
comment of `deploy/nginx/connect.sirony.in.conf`.

## Endpoints

- `GET /healthz` — liveness, no database access
- `GET /readyz` — readiness, verifies a Postgres round-trip (drives the
  container healthcheck)
- `GET /*` — serves the PWA from `public/`, with an SPA fallback to the shell.
  Unknown `/api/*` paths return JSON 404 instead.

## PWA

Everything is hand-written and first-party — no build step, no bundler, no CDN.
Loading the app contacts no origin but this server.

| File                        | Role                                        |
| --------------------------- | ------------------------------------------- |
| `public/index.html`         | App shell                                   |
| `public/sw.js`              | Service worker: offline + caching strategy  |
| `public/manifest.webmanifest` | Install metadata                          |
| `public/offline.html`       | Offline fallback page                       |
| `public/icons/`             | Generated PNGs, incl. a maskable variant    |

Caching strategy, which encodes the privacy rule:

- **Navigations** — network-first, falling back to the cached shell offline
- **Static assets** — cache-first, refreshed in the background
- **`/api/*`, `/healthz`, `/readyz`** — network-only, **never cached**, so no
  user data is left in CacheStorage on a shared or lost device
- Cross-origin requests are ignored by the worker entirely

`sw.js` and HTML are served `no-cache` so a stale worker can't pin users to an
old version; icons get a week, other assets an hour.

Installability requires HTTPS, so the install prompt appears only once nginx
and the certificate are live at connect.sirony.in (localhost is also treated as
a secure origin for testing).

## Privacy posture

Decisions already baked in, all revisable once the PRD sets real requirements:

- Postgres publishes no host port and is unreachable from the internet
- The app binds loopback only, so the container cannot be hit directly
- `Authorization` and `Cookie` headers are redacted from application logs
- Client IPs are omitted from the request log serialiser, and nginx
  `access_log` is off
- Containers run as an unprivileged user with `cap_drop: ALL` and
  `no-new-privileges`
- HSTS, `nosniff`, and a strict referrer policy are set at the edge
- CSP allows `'self'` only, with no `'unsafe-inline'` — keep it that way
- No analytics, no webfonts, no third-party scripts; the frontend makes zero
  cross-origin requests
- The service worker never persists API responses to disk

Deliberate product decisions, each traceable to the PRD:

- **Hearts and follower counts are private.** §8 rules out popularity as a
  reputation signal, so counts return only to their owner.
- **No coordinates anywhere.** Locality is free text at town level.
- **Blocks are undetectable.** A blocked lookup returns the same 404 as a
  nonexistent one.
- **The compatibility radar reports agreements and differences**, never a
  single score, and never a prediction (§6).
- **Watermarking is a deterrent, not a guarantee** — a second camera defeats
  it, and the code says so where it is implemented.

Still open: encryption at rest for user content, and a formal retention
policy beyond the per-object expiry already enforced.

## Deployment in practice

Production is deployed by rsync from a working copy, then rebuilt in place:

```bash
rsync -az --exclude node_modules --exclude dist --exclude .git --exclude .env \
  ./ root@147.93.107.173:/root/sirony-connect/
ssh root@147.93.107.173 'cd /root/sirony-connect && docker compose up -d --build'
```

Migrations run automatically at startup, tracked in `schema_migrations`.
The image never needs to be published for this route.

## Known gaps

1. **Automated backups** — the provider add-on is unpurchased and only manual
   snapshots exist. `make backup` takes a dump; nothing schedules it.
2. **Secret chat is unreviewed crypto.** PRD §7 requires specialist review of
   key management before launch. Do not describe it to users as audited.
3. **No ID verification.** The `verifications` table and state machine exist,
   but no provider is wired up.
4. `DAILY_INTRODUCTIONS` is 5 (`src/routes/discovery.ts`), which is thin for a
   swipe interface. Raise it once there is local density.
