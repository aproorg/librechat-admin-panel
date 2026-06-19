# LibreChat Admin Panel

A browser-based management interface for [LibreChat](https://github.com/danny-avila/LibreChat). It connects to the same database as the main application and provides a GUI for tasks that would otherwise require editing `librechat.yaml` directly.

## Features

- **Configuration management** — View and edit all LibreChat settings through a dynamic, schema-driven form. New fields added to the schema appear automatically.
- **Role and group overrides** — Apply configuration overrides scoped to specific roles or groups, with a priority-based cascade that determines the final resolved value for each user.
- **User and group administration** — Create and manage groups, assign roles, and control access.
- **Authentication** — Supports username/password login and OpenID SSO when enabled on the LibreChat instance.
- **Localization** — Full multi-language support for all UI strings.
- **Accessibility** — Keyboard navigable with ARIA regions, focus management, and screen reader support.

## Getting started

### Local development

```bash
cp .env.example .env   # then edit .env
bun install
bun dev                 # http://localhost:3000
```

### Docker

```bash
cp .env.example .env
# Set SESSION_SECRET (min 32 chars)
# Set VITE_API_BASE_URL=http://host.docker.internal:3080

docker compose up -d    # builds and starts on http://localhost:3000
docker compose down     # stop
```

> **Note:** Inside Docker, `localhost` refers to the container, not your machine.
> Use `http://host.docker.internal:3080` for `VITE_API_BASE_URL` to reach
> LibreChat running on the host.

#### Environment variables

| Variable                        | Required                            | Default                                                                          | Description                                                                                     |
| ------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `PORT`                          | No                                  | `3000`                                                                           | Port the admin panel listens on                                                                 |
| `SESSION_SECRET`                | **Yes** (always required in Docker) | Dev fallback only when running `bun dev` locally; no default in the Docker image | Encryption key for sessions (min 32 chars)                                                      |
| `VITE_API_BASE_URL`             | **Yes** (Docker)                    | `http://localhost:3080` (local dev only)                                         | LibreChat API server URL; use `http://host.docker.internal:<port>` in Docker                    |
| `VITE_BASE_PATH`                | No                                  | `/`                                                                              | URL subpath to serve the panel under (e.g., `/adminpanel`). Must match at build time and runtime |
| `API_SERVER_URL`                | No                                  | Falls back to `VITE_API_BASE_URL`                                                | Server-side LibreChat API URL when the container reaches LibreChat differently than the browser |
| `ADMIN_SSO_ONLY`                | No                                  | `false`                                                                          | Hide email/password form, SSO only                                                              |
| `ADMIN_SSO_ENABLED`             | No                                  | `true`                                                                           | Set `false` to hide the SSO button (and auto-redirect) while keeping email/password login       |
| `ADMIN_SESSION_IDLE_TIMEOUT_MS` | No                                  | `1800000` (30 min)                                                               | Session idle timeout in ms                                                                      |
| `SESSION_COOKIE_SECURE`         | No                                  | `true` in production, `false` otherwise                                          | Set `false` only for plain-HTTP deployments so the browser keeps the admin session cookie       |

For OpenID SSO, the admin panel stores a short-lived PKCE verifier in the
`admin-session` cookie before redirecting to LibreChat. If the admin panel is
served over plain HTTP while running in production mode, browsers reject a
`Secure` session cookie and the callback cannot complete the PKCE exchange. In
that deployment shape, set `SESSION_COOKIE_SECURE=false` on the admin panel.
Set the same override on LibreChat itself when LibreChat is also reached over
plain HTTP, so its OAuth and auth cookies are not dropped either.

#### Standalone Docker build

```bash
docker build -t librechat-admin-panel .
docker run -p 3000:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e SESSION_SECRET=your-secret-here-at-least-32-characters \
  -e VITE_API_BASE_URL=http://host.docker.internal:3080 \
  -e SESSION_COOKIE_SECURE=false \
  librechat-admin-panel

# To serve under a subpath (e.g., /adminpanel):
docker build -t librechat-admin-panel --build-arg VITE_BASE_PATH=/adminpanel .
docker run -p 3000:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e SESSION_SECRET=your-secret-here-at-least-32-characters \
  -e VITE_API_BASE_URL=http://host.docker.internal:3080 \
  -e VITE_BASE_PATH=/adminpanel \
  librechat-admin-panel
```

### AWS Lambda + CloudFront + S3

As an alternative to a long-running container, the panel can run serverless:
static assets on S3 behind CloudFront, and the dynamic part (SSR pages and
server functions) on a single Lambda. `lambda.ts` reuses the same compiled
request handler as `server.ts`, so both deployment shapes share one codebase.

```bash
bun run build:lambda
```

This produces two artifacts:

- `dist/client/` — static assets (hashed bundles, icons, `manifest.json`, …) to upload to S3.
- `dist/lambda/index.mjs` — a self-contained Node ESM bundle (no `node_modules` needed) to deploy as the Lambda.

**Lambda configuration**

| Setting       | Value                                                                 |
| ------------- | --------------------------------------------------------------------- |
| Runtime       | `nodejs20.x` (or newer)                                               |
| Handler       | `index.handler`                                                       |
| Function URL  | Enabled, with invoke mode **`RESPONSE_STREAM`** (the SSR is streamed) |
| Environment   | `SESSION_SECRET` (required), `VITE_API_BASE_URL`, `API_SERVER_URL`    |

`SESSION_COOKIE_SECURE` can keep its production default of `true` because
CloudFront serves the panel over HTTPS. Set `VITE_BASE_PATH` at build time
(`VITE_BASE_PATH=/adminpanel bun run build:lambda`) to serve under a subpath.

**CloudFront routing**

Point CloudFront at two origins and split traffic by path:

| Path pattern                                                        | Origin               | Caching       |
| ------------------------------------------------------------------- | -------------------- | ------------- |
| `/assets/*`, `/favicon.ico`, `/manifest.json`, `/robots.txt`, `*.svg` | S3 (static assets)   | long, public  |
| _default (everything else)_                                         | Lambda Function URL  | none          |

The Lambda handler serves only dynamic routes and already returns
`no-cache, no-store, must-revalidate`; the static files are immutable and
hashed, so S3 can cache them aggressively at the edge.
