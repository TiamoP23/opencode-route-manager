#!/usr/bin/env bash
# shellcheck disable=SC2317
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d)"

#
# Smoke test: build and run the route-manager sidecar alongside a
# node:24-alpine HTTP/WebSocket target and traefik:v3.1 with
# file-provided BasicAuth, exercising the full MCP publish→route→remove
# lifecycle.
#
# Container runtime: podman (preferred) or docker.
#
# Architecture:
#   route-smoke-net (bridge)
#   ├── opencode           ← node:24-alpine, listens :8080, no host port
#   ├── route-manager      ← manager image, listens :3000, host→127.0.0.1:${MANAGER_PORT}
#   └── traefik            ← traefik:v3.1, listens :80, host→127.0.0.1:${TRAEFIK_PORT}
#
# Traefik polls route-manager's HTTP provider on the internal network.
# curl / MCP client access both via loopback-bound host ports.
#

PODMAN=""
if command -v podman &>/dev/null && podman info &>/dev/null 2>&1; then
  PODMAN=podman
elif command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  PODMAN=docker
  echo "NOTE: using docker instead of podman (interchangeable for this test)" >&2
fi

if [ -z "$PODMAN" ]; then
  echo "SKIP: no working container runtime available" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Generate secrets & ports
# ---------------------------------------------------------------------------
MANAGER_PORT=$(shuf -i 20000-65000 -n 1)
TRAEFIK_PORT=$(shuf -i 20000-65000 -n 1)
PROVIDER_TOKEN=$(openssl rand -hex 32)
MCP_TOKEN=$(openssl rand -hex 32)
PASSWD=$(printf 'opencode:%s' "$(openssl passwd -apr1 test)")

# ---------------------------------------------------------------------------
# Generate Traefik static & dynamic YAML under TEST_DIR
# ---------------------------------------------------------------------------
cat > "$TEST_DIR/traefik-static.yml" <<TRAEFIK_STATIC
api:
  insecure: false
providers:
  http:
    endpoint: http://route-manager:3000/traefik
    pollInterval: 2s
    headers:
      Authorization: "Bearer ${PROVIDER_TOKEN}"
  file:
    filename: /etc/traefik/dynamic.yml
    watch: false
entryPoints:
  web:
    address: ":80"
TRAEFIK_STATIC

cat > "$TEST_DIR/traefik-dynamic.yml" <<TRAEFIK_DYNAMIC
http:
  middlewares:
    dev-basic-auth:
      basicAuth:
        users:
          - "${PASSWD}"
TRAEFIK_DYNAMIC

# ---------------------------------------------------------------------------
# Cleanup handler (removes containers, network, volume, temp files)
# ---------------------------------------------------------------------------
cleanup() {
  echo "=== cleanup ==="
  $PODMAN rm -f route-manager opencode traefik 2>/dev/null || true
  $PODMAN network rm route-smoke-net 2>/dev/null || true
  $PODMAN volume rm route-smoke-data 2>/dev/null || true
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Build the production image
# ---------------------------------------------------------------------------
echo "=== build opencode-route-manager:test ==="
$PODMAN build -t opencode-route-manager:test "$ROOT_DIR"

# ---------------------------------------------------------------------------
# Create Podman network and volume
# ---------------------------------------------------------------------------
echo "=== setup network & volume ==="
$PODMAN network create route-smoke-net
$PODMAN volume create route-smoke-data

# ---------------------------------------------------------------------------
# Start upstream HTTP/WebSocket target (container name: opencode)
# ---------------------------------------------------------------------------
echo "=== start opencode (node:24-alpine HTTP+WS responder on :8080) ==="
$PODMAN run -d --name opencode --network route-smoke-net --restart no \
  node:24-alpine sh -c '
cat <<"NODEEOF" > /tmp/server.mjs
import { createServer } from "node:http";
const srv = createServer((req, res) => {
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === "websocket") {
    res.writeHead(101, { "Connection": "Upgrade", "Upgrade": "websocket" });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("route-target");
});
srv.listen(8080, "0.0.0.0");
NODEEOF
node /tmp/server.mjs
'

# ---------------------------------------------------------------------------
# Start route-manager (Cloudflare disabled via dummy values + proxied=false)
# ---------------------------------------------------------------------------
echo "=== start route-manager ==="
$PODMAN run -d --name route-manager --network route-smoke-net \
  --restart no \
  -p "127.0.0.1:${MANAGER_PORT}:3000" \
  -v route-smoke-data:/data \
  -e MCP_TOKEN="${MCP_TOKEN}" \
  -e TRAEFIK_PROVIDER_TOKEN="${PROVIDER_TOKEN}" \
  -e CLOUDFLARE_ZONE_ID=dummy \
  -e CLOUDFLARE_API_TOKEN=dummy \
  -e CLOUDFLARE_CNAME_TARGET=dummy \
  -e CLOUDFLARE_PROXIED=false \
  opencode-route-manager:test

# ---------------------------------------------------------------------------
# Start traefik with file-provided BasicAuth
# ---------------------------------------------------------------------------
echo "=== start traefik ==="
$PODMAN run -d --name traefik --network route-smoke-net \
  --restart no \
  -p "127.0.0.1:${TRAEFIK_PORT}:80" \
  -v "$TEST_DIR/traefik-static.yml:/etc/traefik/traefik.yml:ro" \
  -v "$TEST_DIR/traefik-dynamic.yml:/etc/traefik/dynamic.yml:ro" \
  traefik:v3.1

# ---------------------------------------------------------------------------
# Wait for route-manager health
# ---------------------------------------------------------------------------
echo "=== wait for route-manager health ==="
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${MANAGER_PORT}/health" &>/dev/null; then
    echo "route-manager healthy after ${i}s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "FAIL: route-manager did not become healthy" >&2
    exit 1
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# Smoke assertions
# ---------------------------------------------------------------------------
echo "=== assertions ==="

# 7a. Health endpoint returns 200
echo "--- health check ---"
curl -fsS "http://127.0.0.1:${MANAGER_PORT}/health"

# 7b. Traefik provider endpoint with bearer token
echo "--- provider endpoint with token ---"
curl -fsS -H "Authorization: Bearer ${PROVIDER_TOKEN}" \
  "http://127.0.0.1:${MANAGER_PORT}/traefik"

# 7c. Traefik provider endpoint without token (must error → exit 1)
echo "--- provider endpoint without token (expected: 401) ---"
if curl -fsS "http://127.0.0.1:${MANAGER_PORT}/traefik" 2>/dev/null; then
  echo "FAIL: /traefik without auth should fail" >&2
  exit 1
fi

# 7d. MCP publish_service via smoke client
echo "--- MCP publish route-smoke 8080 ---"
MCP_URL="http://127.0.0.1:${MANAGER_PORT}/mcp" \
MCP_TOKEN="${MCP_TOKEN}" \
node "$ROOT_DIR/tests/helpers/mcp-smoke-client.mjs" publish route-smoke 8080

# Give Traefik a moment to poll the provider
sleep 3

# 7e. Traefik route without BasicAuth → 401
echo "--- traefik route without BasicAuth (expected: 401) ---"
STATUS=$(curl -o /dev/null -sS -w '%{http_code}' \
  -H 'Host: route-smoke.tiamop23.de' \
  "http://127.0.0.1:${TRAEFIK_PORT}" 2>/dev/null || true)
if [ "$STATUS" != "401" ]; then
  echo "FAIL: expected 401, got ${STATUS}" >&2
  exit 1
fi

# 7f. Traefik route with BasicAuth → 200 + "route-target"
echo "--- traefik route with BasicAuth (expected: 200 + route-target) ---"
BODY=$(curl -fsS -u opencode:test \
  -H 'Host: route-smoke.tiamop23.de' \
  "http://127.0.0.1:${TRAEFIK_PORT}" 2>/dev/null || true)
if [ "$BODY" != "route-target" ]; then
  echo "FAIL: expected body 'route-target', got '${BODY}'" >&2
  exit 1
fi

# 7g. WebSocket upgrade via Traefik with BasicAuth → 101
echo "--- websocket upgrade via Traefik with BasicAuth (expected: 101) ---"
UPGRADE=$(curl --http1.1 -isS -u opencode:test \
  -H 'Host: route-smoke.tiamop23.de' \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  "http://127.0.0.1:${TRAEFIK_PORT}/ws" 2>/dev/null | grep -c '101 Switching Protocols' || true)
if [ "$UPGRADE" -eq 0 ]; then
  echo "FAIL: expected 101 Switching Protocols" >&2
  exit 1
fi

# 7h. MCP remove_service
echo "--- MCP remove route-smoke ---"
MCP_URL="http://127.0.0.1:${MANAGER_PORT}/mcp" \
MCP_TOKEN="${MCP_TOKEN}" \
node "$ROOT_DIR/tests/helpers/mcp-smoke-client.mjs" remove route-smoke

# Wait for Traefik provider poll after removal
sleep 3

# 7i. Removed route returns 404
echo "--- verify removal (expected: 404) ---"
REMOVED=$(curl -o /dev/null -sS -w '%{http_code}' -u opencode:test \
  -H 'Host: route-smoke.tiamop23.de' \
  "http://127.0.0.1:${TRAEFIK_PORT}" 2>/dev/null || echo "000")
if [ "$REMOVED" != "404" ]; then
  echo "FAIL: expected 404 after removal, got ${REMOVED}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
echo "=== smoke test PASSED ==="
