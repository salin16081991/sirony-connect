# sirony-connect

Privacy-first social connection platform. Standalone Docker project, deployed
alongside the other `sirony-*` projects on the Hostinger VPS
(Ubuntu 24.04, Mumbai), served at **connect.sirony.in**.

## Status

The **infrastructure and PWA shell are complete**. The **product features are
not** — no domain model, entities, or feature endpoints exist yet, because
those come from the PRD (`privacy-first-social-connection-platform-prd.md`),
which has not been readable from this machine.

What runs today: a Fastify server with health endpoints and a Postgres
connection, serving an installable, offline-capable PWA shell.

## Topology

Two containers, matching the pattern used by the sibling `sirony-*` projects:

| Service | Image             | Exposure                                  |
| ------- | ----------------- | ----------------------------------------- |
| `app`   | built from source | `127.0.0.1:8097` only — never `0.0.0.0`   |
| `db`    | `postgres:17`     | internal network only, no host port       |

TLS terminates at host nginx, which proxies `connect.sirony.in` to the
loopback port. See [`deploy/nginx/`](deploy/nginx/).

## URLs

| Context | URL |
| ------- | --- |
| Public  | **https://connect.sirony.in** |
| Internal bind | `127.0.0.1:8097` — nginx proxies the domain to this |

`127.0.0.1:8097` is never browsed directly in production. It is deliberately
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
curl http://127.0.0.1:8097/healthz
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

Not yet addressed, and dependent on the PRD: encryption at rest for user
content, retention and deletion policy, key management, and whatever
"privacy-first" specifically means for this product's threat model.

## Next steps

1. Supply the PRD
2. Derive the schema into `db/migrations/`
3. Build feature routes under `src/routes/`
4. Add automated Postgres backups — the provider's daily backup add-on is
   unpurchased, and only 2 manual snapshots exist
