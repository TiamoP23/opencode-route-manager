#!/usr/bin/env bash
# shellcheck disable=SC2317
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
RUN_ID="smoke-$(date +%s)-$$"

#
# Smoke test: build and run the route-manager sidecar alongside a
# node:24-alpine HTTP/WebSocket target and traefik:v3.1 with
# file-provided BasicAuth, exercising the full MCP publish→route→remove
# lifecycle.
#
# Prerequisites: podman (preferred) or docker on the host.
#
# Architecture:
#   <run-id>-net (bridge)
#   ├── <run-id>-opencode      ← node:24-alpine, listens :8080, alias "opencode"
#   ├── <run-id>-route-manager ← manager image, alias "route-manager"
#   └── <run-id>-traefik       ← traefik:v3.1, polls http://route-manager:3000/traefik
#
# Traefik's HTTP provider and the port-probe talk to route-manager / opencode
# over the internal bridge network.  curl / MCP client access the manager and
# Traefik via auto-assigned loopback ports discovered at runtime.
#
# Without a working container runtime the script exits non-zero, unless
# SKIP_CONTAINER_SMOKE=1 is set.
#

# ---------------------------------------------------------------------------
# Cleanup — install immediately; safe when no resources exist
# ---------------------------------------------------------------------------
cleanup() {
  echo "=== cleanup ===" >&2
  [ -n "$RUNTIME" ] && $RUNTIME rm -f \
    "${RUN_ID}-opencode" "${RUN_ID}-route-manager" "${RUN_ID}-traefik" \
    2>/dev/null || true
  [ -n "$RUNTIME" ] && $RUNTIME network rm "${RUN_ID}-net" 2>/dev/null || true
  [ -n "$RUNTIME" ] && $RUNTIME volume rm "${RUN_ID}-data" 2>/dev/null || true
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Container runtime detection
# ---------------------------------------------------------------------------
RUNTIME=""
if command -v podman &>/dev/null && podman info &>/dev/null 2>&1; then
  RUNTIME=podman
elif command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  RUNTIME=docker
  echo "NOTE: using docker instead of podman" >&2
fi

if [ -z "$RUNTIME" ]; then
  if [ "${SKIP_CONTAINER_SMOKE:-}" = "1" ]; then
    echo "SKIP: SKIP_CONTAINER_SMOKE=1, no working container runtime" >&2
    exit 0
  fi
  echo "FAIL: no working container runtime (podman or docker)" >&2
  echo "      Set SKIP_CONTAINER_SMOKE=1 to skip this test." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helper: discover auto-assigned loopback host port
# ---------------------------------------------------------------------------
runtime_port() {
  local container="$1" cport="$2"
  $RUNTIME port "$container" "$cport" 2>/dev/null | head -1 | sed 's/.*://'
}

# ---------------------------------------------------------------------------
# Helper: poll URL until expected status is reached
# ---------------------------------------------------------------------------
poll_url() {
  local url="$1" expected="$2" label="$3"
  local max="${4:-15}" i
  for i in $(seq 1 "$max"); do
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo "000")
    if [ "$code" = "$expected" ]; then
      echo "  [${i}s] ${label} → ${expected}" >&2
      return 0
    fi
    sleep 1
  done
  echo "FAIL: ${label} — expected ${expected}, got ${code} after ${max}s" >&2
  # diagnostics
  echo "--- ${RUN_ID}-route-manager logs ---" >&2
  $RUNTIME logs --tail 20 "${RUN_ID}-route-manager" 2>/dev/null || true
  echo "--- ${RUN_ID}-traefik logs ---" >&2
  $RUNTIME logs --tail 20 "${RUN_ID}-traefik" 2>/dev/null || true
  return 1
}

# ---------------------------------------------------------------------------
# Helper: poll URL expecting a specific body, return on match
# ---------------------------------------------------------------------------
poll_body() {
  local url="$1" expected="$2" label="$3"
  local max="${4:-15}" i
  for i in $(seq 1 "$max"); do
    local body
    body=$(curl -fsS "$url" 2>/dev/null || true)
    if [ "$body" = "$expected" ]; then
      echo "  [${i}s] ${label} → body matched" >&2
      return 0
    fi
    sleep 1
  done
  echo "FAIL: ${label} — expected body '${expected}', got '${body}' after ${max}s" >&2
  $RUNTIME logs --tail 20 "${RUN_ID}-route-manager" 2>/dev/null || true
  $RUNTIME logs --tail 20 "${RUN_ID}-traefik" 2>/dev/null || true
  return 1
}

# ---------------------------------------------------------------------------
# Generate secrets & BasicAuth hash (bundled Node, no OpenSSL dependency)
# ---------------------------------------------------------------------------
PROVIDER_TOKEN=$(node -e "const{randomBytes}=require('crypto');process.stdout.write(randomBytes(32).toString('hex'))")
MCP_TOKEN=$(node -e "const{randomBytes}=require('crypto');process.stdout.write(randomBytes(32).toString('hex'))")
BASIC_AUTH_HASH=$(node -e "const{createHash}=require('crypto');const b=createHash('sha1').update('test').digest();process.stdout.write('{SHA}'+b.toString('base64'))")

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
          - "opencode:${BASIC_AUTH_HASH}"
TRAEFIK_DYNAMIC

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
echo "=== build opencode-route-manager:test ===" >&2
$RUNTIME build -t opencode-route-manager:test "$ROOT_DIR"

# ---------------------------------------------------------------------------
# Create shared network & volume
# ---------------------------------------------------------------------------
echo "=== setup network & volume ===" >&2
$RUNTIME network create "${RUN_ID}-net"
$RUNTIME volume create "${RUN_ID}-data"

# ---------------------------------------------------------------------------
# Start upstream HTTP/WebSocket target (network alias: opencode)
# ---------------------------------------------------------------------------
echo "=== start ${RUN_ID}-opencode (node:24-alpine HTTP+WS on :8080) ===" >&2
$RUNTIME run -d --name "${RUN_ID}-opencode" \
  --network "${RUN_ID}-net" --network-alias opencode \
  --restart no \
  node:24-alpine sh -c '
cat <<"NODEEOF" > /tmp/server.mjs
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-5AB5A0BDC5B1";

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("route-target");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
});

server.listen(8080, "0.0.0.0");
NODEEOF
node /tmp/server.mjs
'

# ---------------------------------------------------------------------------
# Start route-manager (Cloudflare disabled by omitting all CLOUDFLARE_* vars)
# ---------------------------------------------------------------------------
echo "=== start ${RUN_ID}-route-manager ===" >&2
$RUNTIME run -d --name "${RUN_ID}-route-manager" \
  --network "${RUN_ID}-net" --network-alias route-manager \
  --restart no \
  -p "127.0.0.1::3000" \
  -v "${RUN_ID}-data:/data" \
  -e MCP_TOKEN="${MCP_TOKEN}" \
  -e TRAEFIK_PROVIDER_TOKEN="${PROVIDER_TOKEN}" \
  opencode-route-manager:test

# ---------------------------------------------------------------------------
# Start traefik with file-provided BasicAuth
# ---------------------------------------------------------------------------
echo "=== start ${RUN_ID}-traefik ===" >&2
$RUNTIME run -d --name "${RUN_ID}-traefik" \
  --network "${RUN_ID}-net" \
  --restart no \
  -p "127.0.0.1::80" \
  -v "$TEST_DIR/traefik-static.yml:/etc/traefik/traefik.yml:ro" \
  -v "$TEST_DIR/traefik-dynamic.yml:/etc/traefik/dynamic.yml:ro" \
  traefik:v3.1

# ---------------------------------------------------------------------------
# Discover auto-assigned loopback ports
# ---------------------------------------------------------------------------
echo "=== discover host ports ===" >&2
MANAGER_PORT=""
TRAEFIK_PORT=""
for i in $(seq 1 10); do
  MANAGER_PORT=$(runtime_port "${RUN_ID}-route-manager" 3000)
  TRAEFIK_PORT=$(runtime_port "${RUN_ID}-traefik" 80)
  [ -n "$MANAGER_PORT" ] && [ -n "$TRAEFIK_PORT" ] && break
  sleep 1
done
if [ -z "$MANAGER_PORT" ] || [ -z "$TRAEFIK_PORT" ]; then
  echo "FAIL: could not discover host ports" >&2
  exit 1
fi
echo "  route-manager → 127.0.0.1:${MANAGER_PORT}" >&2
echo "  traefik       → 127.0.0.1:${TRAEFIK_PORT}" >&2

# ---------------------------------------------------------------------------
# Wait for route-manager health
# ---------------------------------------------------------------------------
echo "=== wait for route-manager health ===" >&2
poll_url "http://127.0.0.1:${MANAGER_PORT}/health" 200 "health" 30 || exit 1

# ---------------------------------------------------------------------------
# Smoke assertions
# ---------------------------------------------------------------------------
echo "=== assertions ===" >&2

# 7a. Health endpoint returns 200
echo "--- health check ---" >&2
curl -fsS "http://127.0.0.1:${MANAGER_PORT}/health"

# 7b. Traefik provider endpoint with bearer token
echo "--- provider endpoint with token ---" >&2
curl -fsS -H "Authorization: Bearer ${PROVIDER_TOKEN}" \
  "http://127.0.0.1:${MANAGER_PORT}/traefik" > /dev/null

# 7c. Traefik provider endpoint without token → 401
echo "--- provider endpoint without token (expected: 401) ---" >&2
if curl -fsS "http://127.0.0.1:${MANAGER_PORT}/traefik" 2>/dev/null; then
  echo "FAIL: /traefik without auth should fail" >&2
  exit 1
fi

# 7d. MCP publish_service via smoke client
echo "--- MCP publish route-smoke 8080 ---" >&2
MCP_URL="http://127.0.0.1:${MANAGER_PORT}/mcp" \
MCP_TOKEN="${MCP_TOKEN}" \
node "$ROOT_DIR/tests/helpers/mcp-smoke-client.mjs" publish route-smoke 8080

# 7e. Poll Traefik route without BasicAuth → 401
echo "--- traefik route without BasicAuth (expected: 401) ---" >&2
poll_url "http://127.0.0.1:${TRAEFIK_PORT}" 401 \
  "route-smoke.tiamop23.de (no auth)" || exit 1

# 7f. Traefik route with BasicAuth → 200 + "route-target"
echo "--- traefik route with BasicAuth (expected: 200 + route-target) ---" >&2
poll_body "http://opencode:test@127.0.0.1:${TRAEFIK_PORT}" "route-target" \
  "route-smoke.tiamop23.de (BasicAuth)" || exit 1

# 7g. WebSocket upgrade via Traefik with BasicAuth → 101
echo "--- websocket upgrade via Traefik (expected: 101) ---" >&2
WS_KEY="dGhlIHNhbXBsZSBub25jZQ=="
UPGRADE=$(curl --http1.1 -isS -u opencode:test \
  -H 'Host: route-smoke.tiamop23.de' \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H "Sec-WebSocket-Key: ${WS_KEY}" \
  -H 'Sec-WebSocket-Version: 13' \
  "http://127.0.0.1:${TRAEFIK_PORT}/ws" 2>/dev/null | grep -c '101 Switching Protocols' || true)
if [ "$UPGRADE" -eq 0 ]; then
  echo "FAIL: expected 101 Switching Protocols" >&2
  $RUNTIME logs --tail 20 "${RUN_ID}-route-manager" 2>/dev/null || true
  $RUNTIME logs --tail 20 "${RUN_ID}-traefik" 2>/dev/null || true
  exit 1
fi

# 7h. MCP remove_service
echo "--- MCP remove route-smoke ---" >&2
MCP_URL="http://127.0.0.1:${MANAGER_PORT}/mcp" \
MCP_TOKEN="${MCP_TOKEN}" \
node "$ROOT_DIR/tests/helpers/mcp-smoke-client.mjs" remove route-smoke

# 7i. Poll for removed route → 404
echo "--- verify removal (poll for 404) ---" >&2
poll_url "http://127.0.0.1:${TRAEFIK_PORT}" 404 \
  "removed route-smoke" 20 || exit 1

# ---------------------------------------------------------------------------
echo "=== smoke test PASSED ===" >&2
