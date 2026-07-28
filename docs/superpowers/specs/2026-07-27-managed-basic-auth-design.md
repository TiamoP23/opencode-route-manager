# Managed BasicAuth Design

## Goal

Allow route-manager to publish the BasicAuth middleware used by its generated
routers. A password-based deployment can pass the same workspace password to
OpenCode, code-server, and route-manager without maintaining a separate
Traefik file-provider middleware or htpasswd file.

The generated middleware also ensures that the HTTP provider document remains
non-empty after the final route is removed, so Traefik applies the new document
instead of retaining the last router.

## Scope

This change affects only the `opencode-route-manager` application repository
and its container image. It does not modify the server Compose-stack
repository.

The deployed Compose file can opt into managed authentication by passing:

```yaml
- BASIC_AUTH_PASSWORD=${WORKSPACE_PASSWORD}
```

The existing external-middleware mode remains supported for Authentik and
other Traefik middleware providers.

## Configuration Modes

### Managed BasicAuth

Managed mode is enabled when `BASIC_AUTH_PASSWORD` is present and non-empty.

- `BASIC_AUTH_PASSWORD`: required in managed mode.
- `BASIC_AUTH_USERNAME`: optional; defaults to `opencode`.
- `TRAEFIK_MIDDLEWARE`: must not be explicitly set in managed mode. Startup
  fails if both managed and external middleware configuration are supplied.

The username must contain 1-64 ASCII characters from `A-Z`, `a-z`, `0-9`,
`.`, `_`, and `-`. Colons, control characters, whitespace, and newlines are
rejected.

The password must contain 1-72 UTF-8 bytes. Values over 72 bytes are rejected
because bcrypt would otherwise truncate them silently.

### External Middleware

When `BASIC_AUTH_PASSWORD` is absent, route-manager keeps the current behavior:

- `TRAEFIK_MIDDLEWARE` selects the administrator-managed middleware.
- If omitted, it defaults to `dev-basic-auth@file` for backward compatibility.
- Supplying `BASIC_AUTH_USERNAME` without a password is a configuration error.

This mode supports middleware references such as `test-auth@file` and
`authentik-forward-auth@file`.

## Password Hashing

Add the pure-JavaScript `bcryptjs` package so the Alpine image does not require
native build tooling or a native runtime dependency.

Route-manager hashes the password once during startup with bcrypt cost 12.
Hashing finishes before the HTTP server starts. The plaintext is not persisted,
returned by an endpoint, or written to logs. The runtime Traefik configuration
retains only the username and bcrypt hash.

Any hashing failure aborts startup with the existing sanitized
`startup_failed` event. Error output must not contain the password.

## Traefik Provider Document

Extend `TraefikDocument.http` with a `middlewares` map.

### Managed Document

Managed mode always publishes:

```yaml
http:
  middlewares:
    agent-basic-auth:
      basicAuth:
        users:
          - "opencode:<bcrypt-hash>"
        removeHeader: true
```

Generated routers reference `agent-basic-auth`. Because the router and
middleware come from the same HTTP provider, no cross-provider suffix is
required. Traefik exposes the resolved name as `agent-basic-auth@http`.

The middleware remains present when there are no active routes. The provider
document is therefore non-empty, and Traefik removes routers and services from
the previous HTTP-provider document.

### External Document

External mode keeps each router's configured middleware reference and always
publishes one unused sentinel middleware:

```yaml
http:
  middlewares:
    agent-provider-sentinel:
      headers:
        customRequestHeaders:
          X-Route-Manager-Sentinel: "1"
```

No router references this middleware. It has no request effect, but keeps a
zero-route document non-empty so Traefik applies route removal.

## Data Flow

1. Startup loads and validates control tokens, Cloudflare configuration, and
   authentication mode.
2. Managed mode hashes `BASIC_AUTH_PASSWORD` once and stores only the bcrypt
   result in runtime configuration.
3. `/traefik` reads active routes from SQLite.
4. The projection builds a complete HTTP-provider document containing the
   managed middleware or external-mode sentinel, plus active routers and
   services.
5. Traefik polls the document and atomically replaces the previous HTTP
   provider configuration.
6. Removing the final route deletes Cloudflare DNS and the SQLite row. The next
   provider poll receives a middleware-only document and clears the stale
   router.

## Password Rotation

For the password-based deployment, update `WORKSPACE_PASSWORD` and recreate:

- OpenCode
- code-server
- route-manager

Route-manager generates a new bcrypt hash at startup. Traefik receives it on
the next provider poll and does not require a restart.

## Security

- The plaintext password is accepted only through the process environment.
- Password and hash values are excluded from structured logs and public errors.
- The bcrypt hash is returned only by the bearer-protected `/traefik` endpoint.
- Managed BasicAuth uses `removeHeader: true`, preventing the upstream service
  from receiving the BasicAuth Authorization header.
- Username validation prevents htpasswd-entry and configuration injection.
- Existing MCP and Traefik provider bearer tokens remain distinct.
- Anyone with host-level container inspection privileges can already inspect
  the OpenCode and code-server password environment; managed mode does not
  create a new trust boundary beyond those host privileges.

## Compatibility

- Existing deployments without `BASIC_AUTH_PASSWORD` continue using
  `TRAEFIK_MIDDLEWARE` unchanged.
- Existing file-provider or Authentik middleware definitions can remain in
  Traefik even when managed mode is selected; they are simply not referenced
  by generated routes.
- No database migration is required.
- The HTTP provider authentication and Cloudflare ownership contracts are
  unchanged.

## Testing

Apply TDD for all new behavior.

Unit tests cover:

- managed-mode selection and default username;
- external-mode backward compatibility;
- ambiguous managed-plus-external configuration rejection;
- username validation;
- empty and over-72-byte password rejection;
- bcrypt hash verification without exposing plaintext;
- managed middleware shape and router reference;
- external sentinel shape and router reference;
- zero-route documents remaining non-empty in both modes;
- non-active rows remaining excluded from projection.

The container smoke test changes to managed BasicAuth:

- route-manager receives `BASIC_AUTH_PASSWORD=test`;
- Traefik no longer receives a file-provider BasicAuth definition for the test;
- publish yields unauthenticated 401 and authenticated HTTP success;
- WebSocket upgrade succeeds with BasicAuth;
- removal yields Traefik 404 after the provider poll without restarting
  Traefik;
- the route-manager container still runs as the non-root `node` user.

Run the full Node test suite, typecheck, build, shell syntax checks, and host
container smoke before release.

## Deployment Changes After Release

The deployed password-based Compose stack changes only the route-manager
environment:

```yaml
- BASIC_AUTH_PASSWORD=${WORKSPACE_PASSWORD}
```

Remove `TRAEFIK_MIDDLEWARE=test-auth@file` from route-manager. The existing
Traefik `test-auth` middleware file may remain but is unused. No additional
Traefik dynamic middleware file or users-file mount is required.
