# opencode-route-manager

MCP sidecar that manages HTTP route registrations backed by Traefik dynamic
configuration and optional Cloudflare DNS.

## Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `MCP_TOKEN` | — | **Yes** | Control-plane token (≥32 chars, alphanumeric/underscore/hyphen). Used to authenticate MCP tool calls. |
| `TRAEFIK_PROVIDER_TOKEN` | — | **Yes** | Provider token (≥32 chars, alphanumeric/underscore/hyphen, different from `MCP_TOKEN`). Used to authenticate the Traefik HTTP provider endpoint. |
| `DATABASE_PATH` | `/data/routes.sqlite` | No | SQLite database path (persistent volume recommended). |
| `LISTEN_HOST` | `0.0.0.0` | No | HTTP listen address. |
| `LISTEN_PORT` | `3000` | No | HTTP listen port. |
| `UPSTREAM_HOST` | `opencode` | No | Container hostname used for port-probe connectivity checks. Published apps must be reachable at `UPSTREAM_HOST:{port}`. |
| `PUBLIC_DOMAIN` | `tiamop23.de` | No | Public domain for generated routes (e.g. `{slug}.tiamop23.de`). |
| `BASIC_AUTH_PASSWORD` | - | No | Enables route-manager-managed BasicAuth. Pass the same password used by OpenCode/code-server. Must be non-empty and at most 72 UTF-8 bytes. Mutually exclusive with `TRAEFIK_MIDDLEWARE`. |
| `BASIC_AUTH_USERNAME` | `opencode` | No | Username for managed BasicAuth; 1-64 ASCII letters, digits, `.`, `_`, or `-`. Only effective when `BASIC_AUTH_PASSWORD` is set. |
| `TRAEFIK_MIDDLEWARE` | `dev-basic-auth@file` | No | External middleware reference used only when `BASIC_AUTH_PASSWORD` is absent. |
| `MIN_PORT` | `1024` | No | Minimum allowed target port. |
| `MAX_PORT` | `65535` | No | Maximum allowed target port. |
| `DENIED_PORTS` | `4096` | No | Comma-separated list of ports that are never allowed. |
| `RESERVED_SLUGS` | `opencode,code,auth,traefik,dockge,grafana` | No | Comma-separated list of slugs that cannot be registered. |
| `MAX_ROUTES` | `32` | No | Maximum concurrent route count (1–1000). |
| `PROBE_TIMEOUT_MS` | `1000` | No | Port-probe timeout in milliseconds. |
| `CLOUDFLARE_TIMEOUT_MS` | `5000` | No | Cloudflare API timeout in milliseconds. |
| `CLOUDFLARE_ZONE_ID` | — | No | Cloudflare zone ID. Omit all three `CLOUDFLARE_*` variables to disable DNS management. |
| `CLOUDFLARE_API_TOKEN` | — | No | Cloudflare API token. |
| `CLOUDFLARE_CNAME_TARGET` | — | No | Cloudflare CNAME target. |
| `CLOUDFLARE_PROXIED` | `true` | No | Whether Cloudflare proxying (orange cloud) is enabled. |

> **Cloudflare note**: To enable DNS record management, set all three of
> `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_CNAME_TARGET`.
> If only one or two are set, the application will fail to start. To disable
> Cloudflare entirely, **omit all three variables** — DNS operations are
> skipped and the route lifecycle (publish → Traefik → remove) works without
> them.

## MCP Tools

The manager exposes four tools over the MCP protocol (Streamable HTTP transport at `POST /mcp`).

| Tool | Input | Output | Description |
|------|-------|--------|-------------|
| `publish_service` | `{ slug, port, description? }` | `{ service, url }` | Register and activate a new route. Returns the route record and public URL. |
| `update_service` | `{ slug, port?, description? }` | `{ service, url }` | Update an existing route's port and/or description. |
| `remove_service` | `{ slug }` | `{ slug, removed }` | Remove a route and clean up DNS. |
| `list_services` | `{}` | `{ services }` | List all routes with status. |

### Route States

- **creating** — Route is being set up (port probe, DNS registration if enabled).
- **active** — Route is live and serving traffic through Traefik.
- **deleting** — Route is being torn down (DNS cleanup if enabled, Traefik configuration removal).

## Architecture

```
┌─────────────┐     MCP tools      ┌──────────────────┐
│   Clients   │ ◄───────────────── │  route-manager   │
│  (MCP SDK)  │   (StreamableHTTP) │  :3000/mcp       │
└─────────────┘                    │                  │
                                   │  HTTP provider   │
┌─────────────┐     Traefik HTTP   │  :3000/traefik   │
│   traefik   │ ◄───────────────── │                  │
│   :80       │   provider poll    │  Health          │
│             │                    │  :3000/health    │
│ BasicAuth   │                    └────────┬─────────┘
│ middleware  │                             │ port-probe
└──────┬──────┘                             │
       │                    ┌───────────────▼────────────┐
       │  HTTP reverse      │  upstream container        │
       │  proxy             │  (network alias: opencode) │
       └───────────────────►│  :{publishedPort}           │
                            └────────────────────────────┘
```

### Key points

- **Bind apps to `0.0.0.0`**: The port-probe connects to `UPSTREAM_HOST:{port}`
  (defaults to `opencode:{port}`) from inside the manager container. Your app
  must be reachable at that hostname on the same container network and listen
  on all interfaces (`0.0.0.0`).
- **Database persistence**: SQLite lives at `DATABASE_PATH` (default
  `/data/routes.sqlite`). Mount a volume at `/data` to survive restarts.
- **Control-token rotation**: Both `MCP_TOKEN` and `TRAEFIK_PROVIDER_TOKEN` can
  be rotated at any time. The manager reads its config once at startup — a
  restart is required to pick up new tokens.
- **Health endpoint**: `GET /health` returns 200 when the database is reachable
  and 503 otherwise (no body). Use this as your container health-check target.
- **Cloudflare token scope**: When Cloudflare is enabled, the
  `CLOUDFLARE_API_TOKEN` needs `Zone.DNS:Edit` permission for the target zone.
  Tokens are never logged or exposed in error messages.

## Managed BasicAuth

For a password-based deployment, pass the same secret to OpenCode and
route-manager:

```yaml
- OPENCODE_SERVER_PASSWORD=${WORKSPACE_PASSWORD}
- BASIC_AUTH_PASSWORD=${WORKSPACE_PASSWORD}
```

Route-manager hashes the password with bcrypt cost 12 at startup and publishes
`agent-basic-auth@http`. The plaintext password remains only in the process
environment; route-manager does not persist it in SQLite or provider state and
does not write it to logs. The runtime provider document contains only the
bcrypt hash. Remove `TRAEFIK_MIDDLEWARE` in managed mode. Existing Authentik or
file-provider deployments can omit `BASIC_AUTH_PASSWORD` and continue using
`TRAEFIK_MIDDLEWARE`.

The managed middleware is configured with `removeHeader: true`, so the upstream
container never receives the Authorization header. It remains in zero-route
provider documents, allowing Traefik to remove the final router without a
restart.

To rotate the password, update the shared password and recreate OpenCode,
code-server, and route-manager; Traefik updates on its next HTTP-provider poll.

## Local Development

```bash
# Install dependencies
npm ci

# Run tests (vitest)
npm test

# Type-check
npm run typecheck

# Build (TypeScript → dist/)
npm run build

# Build container image
docker build -t opencode-route-manager:test .

# Container smoke test (requires podman or docker on the host)
# The smoke script needs a working rootless Podman or Docker daemon.
# SKIP_CONTAINER_SMOKE=1 permits a clean skip only when no working
# container runtime is available on the host. When intentionally
# omitting the container smoke, run the non-container steps (npm test,
# typecheck, build) separately. Do not rely on the environment variable
# to skip an existing runtime.
SKIP_CONTAINER_SMOKE=1 bash tests/container-smoke.sh
```

### Vite / Frontend Example

If you run a Vite dev server inside the same container network (reachable at
the `opencode` hostname):

```bash
# In your application container (network alias: opencode):
npm run dev -- --host 0.0.0.0 --port 5173
```

Then publish the route:

```bash
MCP_URL=http://route-manager:3000/mcp MCP_TOKEN=<your-mcp-token> \
  node tests/helpers/mcp-smoke-client.mjs publish demo 5173
```

Your app will be proxied through Traefik. In managed BasicAuth mode the
`agent-basic-auth@http` middleware is applied automatically; otherwise the
middleware configured by `TRAEFIK_MIDDLEWARE` is used (default:
`dev-basic-auth@file`). The public URL uses `PUBLIC_DOMAIN` (e.g.,
`https://demo.tiamop23.de`). Note that port 5173 must be reachable at
`UPSTREAM_HOST:5173` (the `opencode` container on the internal network).
