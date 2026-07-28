# Managed BasicAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let route-manager publish a bcrypt BasicAuth middleware from the shared workspace password while preserving external middleware compatibility and reliably clearing the final Traefik route.

**Architecture:** Add a focused managed-auth module that validates and hashes an optional password during configuration loading. Extend the HTTP-provider projection to always publish a middleware: the real managed BasicAuth middleware in managed mode or an unused sentinel in external mode. Update the container smoke to exercise managed auth without any file-provider BasicAuth configuration.

**Tech Stack:** Node.js 24, TypeScript 7, `bcryptjs` 3.0.3, Traefik 3.1 HTTP provider, Vitest 4, Bash container smoke.

## Global Constraints

- Modify only `/home/workspace/projects/opencode-route-manager`; do not modify `server-compose-stack`.
- Pin `bcryptjs` exactly to `3.0.3`; do not add a native bcrypt dependency.
- Managed mode is selected only by a non-empty `BASIC_AUTH_PASSWORD`.
- Reject an explicitly empty `BASIC_AUTH_PASSWORD`; absence alone selects external mode.
- `BASIC_AUTH_USERNAME` defaults to `opencode` and accepts only 1-64 ASCII letters, digits, `.`, `_`, or `-`.
- Reject passwords over bcrypt's 72-byte UTF-8 limit; never silently truncate.
- Reject explicit `TRAEFIK_MIDDLEWARE` together with managed BasicAuth.
- External mode remains backward-compatible and defaults to `dev-basic-auth@file`.
- Never log, persist, or expose the plaintext BasicAuth password.
- Managed BasicAuth uses bcrypt cost 12 and `removeHeader: true`.
- Every HTTP-provider document must remain non-empty even when there are zero active routes.
- Only active database rows produce routers and services.
- Keep MCP/provider token separation, Cloudflare behavior, fixed upstream host, and database schema unchanged.
- Apply TDD for each behavior change and commit after every task.

## File Map

- Create `src/basic-auth.ts`: validate managed-auth environment and build one bcrypt user entry.
- Modify `src/config.ts`: select managed or external mode and expose resolved authentication data.
- Modify `src/traefik.ts`: emit managed middleware or external sentinel in every provider document.
- Modify `tests/basic-auth.test.ts`: focused password, username, hashing, and secrecy tests.
- Modify `tests/config.test.ts`: mode selection, defaults, and ambiguity tests.
- Modify `tests/traefik.test.ts`: middleware projection and zero-route replacement tests.
- Modify `tests/container-smoke.sh`: exercise HTTP-provider-managed BasicAuth and final-route removal.
- Modify `tests/shell-syntax.test.ts`: prevent reintroduction of file-provider BasicAuth in the smoke harness.
- Modify `README.md`: document managed/external modes and password rotation.
- Modify `package.json`, `package-lock.json`: pin `bcryptjs` 3.0.3.
- Modify test config fixtures in `tests/http.test.ts`, `tests/mcp.test.ts`, `tests/policy.test.ts`, and `tests/route-service.test.ts` to include `managedBasicAuth: null`.

---

### Task 1: Validate And Hash Managed BasicAuth Configuration

**Files:**
- Create: `src/basic-auth.ts`
- Create: `tests/basic-auth.test.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/http.test.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `tests/policy.test.ts`
- Modify: `tests/route-service.test.ts`
- Modify: `tests/traefik.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `ManagedBasicAuth { username: string; userEntry: string }`.
- Produces: `PasswordHasher = (password: string, cost: number) => string`.
- Produces: `loadManagedBasicAuth(env, hashPassword?): ManagedBasicAuth | null`.
- Extends: `AppConfig.managedBasicAuth: ManagedBasicAuth | null`.
- Sets: `AppConfig.middleware` to `agent-basic-auth` in managed mode or the existing external reference otherwise.

- [ ] **Step 1: Write failing focused tests for managed-auth validation and hashing**

Create `tests/basic-auth.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { compareSync } from 'bcryptjs';
import {
  BCRYPT_COST,
  loadManagedBasicAuth,
  type PasswordHasher,
} from '../src/basic-auth.js';

describe('loadManagedBasicAuth', () => {
  it('returns null when managed auth is not configured', () => {
    expect(loadManagedBasicAuth({})).toBeNull();
  });

  it('rejects an explicitly empty password', () => {
    expect(() => loadManagedBasicAuth({ BASIC_AUTH_PASSWORD: '' }))
      .toThrow(/BASIC_AUTH_PASSWORD/);
  });

  it('uses username opencode and cost 12', () => {
    const hashPassword = vi.fn<PasswordHasher>(() => '$2b$12$test-hash');
    expect(loadManagedBasicAuth(
      { BASIC_AUTH_PASSWORD: 'secret' },
      hashPassword,
    )).toEqual({
      username: 'opencode',
      userEntry: 'opencode:$2b$12$test-hash',
    });
    expect(hashPassword).toHaveBeenCalledWith('secret', BCRYPT_COST);
  });

  it.each(['bad:user', 'bad user', 'bad\nuser', '', 'a'.repeat(65)])(
    'rejects invalid username %j',
    (username) => {
      expect(() => loadManagedBasicAuth({
        BASIC_AUTH_PASSWORD: 'secret',
        BASIC_AUTH_USERNAME: username,
      })).toThrow(/BASIC_AUTH_USERNAME/);
    },
  );

  it('rejects username without a password', () => {
    expect(() => loadManagedBasicAuth({ BASIC_AUTH_USERNAME: 'opencode' }))
      .toThrow(/BASIC_AUTH_USERNAME.*BASIC_AUTH_PASSWORD/);
  });

  it('rejects passwords that bcrypt would truncate', () => {
    expect(() => loadManagedBasicAuth({ BASIC_AUTH_PASSWORD: 'x'.repeat(73) }))
      .toThrow(/72 bytes/);
    expect(() => loadManagedBasicAuth({ BASIC_AUTH_PASSWORD: '€'.repeat(25) }))
      .toThrow(/72 bytes/);
  });

  it('creates a real bcrypt entry without retaining plaintext', () => {
    const result = loadManagedBasicAuth({ BASIC_AUTH_PASSWORD: 'secret' });
    expect(result).not.toBeNull();
    const hash = result!.userEntry.slice('opencode:'.length);
    expect(compareSync('secret', hash)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
```

- [ ] **Step 2: Run the focused test and observe the missing module failure**

Run:

```bash
npx vitest run tests/basic-auth.test.ts
```

Expected: FAIL because `src/basic-auth.ts` does not exist and `bcryptjs` is not installed.

- [ ] **Step 3: Pin bcryptjs and implement the managed-auth module**

Run:

```bash
npm install --save-exact bcryptjs@3.0.3
```

Create `src/basic-auth.ts`:

```typescript
import { hashSync, truncates } from 'bcryptjs';

export const BCRYPT_COST = 12;
export const MANAGED_MIDDLEWARE_NAME = 'agent-basic-auth';

export interface ManagedBasicAuth {
  username: string;
  userEntry: string;
}

export type PasswordHasher = (password: string, cost: number) => string;

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function loadManagedBasicAuth(
  env: Record<string, string | undefined>,
  hashPassword: PasswordHasher = hashSync,
): ManagedBasicAuth | null {
  const passwordValue = env['BASIC_AUTH_PASSWORD'];
  const usernameValue = env['BASIC_AUTH_USERNAME'];

  if (passwordValue === undefined) {
    if (usernameValue !== undefined) {
      throw new Error('BASIC_AUTH_USERNAME requires BASIC_AUTH_PASSWORD');
    }
    return null;
  }

  if (passwordValue === '') {
    throw new Error('BASIC_AUTH_PASSWORD must contain 1-72 bytes');
  }

  const username = usernameValue ?? 'opencode';
  if (!USERNAME_RE.test(username)) {
    throw new Error('BASIC_AUTH_USERNAME must contain 1-64 letters, digits, dot, underscore, or hyphen characters');
  }
  if (truncates(passwordValue)) {
    throw new Error('BASIC_AUTH_PASSWORD must not exceed 72 bytes');
  }

  const passwordHash = hashPassword(passwordValue, BCRYPT_COST);
  return { username, userEntry: `${username}:${passwordHash}` };
}
```

- [ ] **Step 4: Run the focused tests and verify managed-auth behavior passes**

Run:

```bash
npx vitest run tests/basic-auth.test.ts
```

Expected: all `loadManagedBasicAuth` tests PASS.

- [ ] **Step 5: Write failing configuration mode tests**

Append to `tests/config.test.ts`:

```typescript
it('selects managed BasicAuth and its provider-local middleware', () => {
  const config = loadConfig(
    { ...required, BASIC_AUTH_PASSWORD: 'secret' },
    { hashPassword: () => '$2b$12$managed' },
  );
  expect(config.managedBasicAuth).toEqual({
    username: 'opencode',
    userEntry: 'opencode:$2b$12$managed',
  });
  expect(config.middleware).toBe('agent-basic-auth');
});

it('rejects managed and explicit external middleware together', () => {
  expect(() => loadConfig(
    {
      ...required,
      BASIC_AUTH_PASSWORD: 'secret',
      TRAEFIK_MIDDLEWARE: 'test-auth@file',
    },
    { hashPassword: () => '$2b$12$managed' },
  )).toThrow(/BASIC_AUTH_PASSWORD.*TRAEFIK_MIDDLEWARE/);
});

it('rejects even an empty explicit external middleware in managed mode', () => {
  expect(() => loadConfig(
    {
      ...required,
      BASIC_AUTH_PASSWORD: 'secret',
      TRAEFIK_MIDDLEWARE: '',
    },
    { hashPassword: () => '$2b$12$managed' },
  )).toThrow(/BASIC_AUTH_PASSWORD.*TRAEFIK_MIDDLEWARE/);
});

it('preserves external middleware compatibility', () => {
  const config = loadConfig({ ...required, TRAEFIK_MIDDLEWARE: 'test-auth@file' });
  expect(config.managedBasicAuth).toBeNull();
  expect(config.middleware).toBe('test-auth@file');
});
```

- [ ] **Step 6: Run configuration tests and observe type/behavior failures**

Run:

```bash
npx vitest run tests/config.test.ts
```

Expected: FAIL because `loadConfig` has no dependency parameter or `managedBasicAuth` output.

- [ ] **Step 7: Extend AppConfig and loadConfig**

Update the beginning of `src/config.ts`:

```typescript
import type { CloudflareConfig } from './domain.js';
import {
  MANAGED_MIDDLEWARE_NAME,
  loadManagedBasicAuth,
  type ManagedBasicAuth,
  type PasswordHasher,
} from './basic-auth.js';

export interface AppConfig {
  // existing fields remain unchanged
  middleware: string;
  managedBasicAuth: ManagedBasicAuth | null;
  // remaining existing fields remain unchanged
}

interface ConfigDependencies {
  hashPassword?: PasswordHasher;
}
```

Change the signature and resolve auth before returning:

```typescript
export function loadConfig(
  env: Record<string, string | undefined>,
  dependencies: ConfigDependencies = {},
): AppConfig {
  // existing token, Cloudflare, and port validation remains unchanged

  const managedBasicAuth = loadManagedBasicAuth(
    env,
    dependencies.hashPassword,
  );
  const explicitMiddleware = env['TRAEFIK_MIDDLEWARE'];
  if (managedBasicAuth && explicitMiddleware !== undefined) {
    throw new Error('BASIC_AUTH_PASSWORD cannot be combined with TRAEFIK_MIDDLEWARE');
  }
  const middleware = managedBasicAuth
    ? MANAGED_MIDDLEWARE_NAME
    : explicitMiddleware || 'dev-basic-auth@file';

  return {
    // existing returned fields remain unchanged
    middleware,
    managedBasicAuth,
    // remaining existing returned fields remain unchanged
  };
}
```

Add `managedBasicAuth: null` beside `middleware` in every manually constructed `AppConfig` fixture in:

```text
tests/http.test.ts
```

- [ ] **Step 8: Run focused tests, typecheck, and verify both modes pass**

Run:

```bash
npx vitest run tests/basic-auth.test.ts tests/config.test.ts
npm run typecheck
```

Expected: focused tests PASS and TypeScript reports no errors.

- [ ] **Step 9: Commit managed-auth configuration**

```bash
git add package.json package-lock.json src/basic-auth.ts src/config.ts \
  tests/basic-auth.test.ts tests/config.test.ts tests/http.test.ts \
  tests/mcp.test.ts tests/policy.test.ts tests/route-service.test.ts \
  tests/traefik.test.ts
git commit -m "feat: add managed basic auth configuration"
```

---

### Task 2: Publish Middleware And Clear The Final Route

**Files:**
- Modify: `src/traefik.ts`
- Modify: `tests/traefik.test.ts`

**Interfaces:**
- Consumes: `AppConfig.managedBasicAuth` and `AppConfig.middleware` from Task 1.
- Produces: `TraefikDocument.http.middlewares` on every provider response.
- Produces: managed middleware `agent-basic-auth` or external sentinel `agent-provider-sentinel`.

- [ ] **Step 1: Replace the empty-projection expectation with zero-route middleware tests**

Replace the existing `returns empty projection for empty routes` test in `tests/traefik.test.ts` with:

```typescript
it('keeps an external-mode zero-route document non-empty with an unused sentinel', () => {
  expect(buildTraefikDocument([], config)).toEqual({
    http: {
      routers: {},
      services: {},
      middlewares: {
        'agent-provider-sentinel': {
          headers: {
            customRequestHeaders: {
              'X-Route-Manager-Sentinel': '1',
            },
          },
        },
      },
    },
  });
});

it('publishes managed BasicAuth even with zero routes', () => {
  const managed = {
    ...config,
    middleware: 'agent-basic-auth',
    managedBasicAuth: {
      username: 'opencode',
      userEntry: 'opencode:$2b$12$hash',
    },
  };
  expect(buildTraefikDocument([], managed).http.middlewares).toEqual({
    'agent-basic-auth': {
      basicAuth: {
        users: ['opencode:$2b$12$hash'],
        removeHeader: true,
      },
    },
  });
});
```

Add a managed route projection test:

```typescript
it('references the provider-managed middleware without a provider suffix', () => {
  const managed = {
    ...config,
    middleware: 'agent-basic-auth',
    managedBasicAuth: {
      username: 'opencode',
      userEntry: 'opencode:$2b$12$hash',
    },
  };
  const doc = buildTraefikDocument([activeRoute('demo', 5173)], managed);
  expect(doc.http.routers['agent-demo']!.middlewares)
    .toEqual(['agent-basic-auth']);
  expect(JSON.stringify(doc)).not.toContain('secret');
});
```

- [ ] **Step 2: Run projection tests and observe missing middleware failures**

Run:

```bash
npx vitest run tests/traefik.test.ts
```

Expected: FAIL because `TraefikDocument` and `buildTraefikDocument` do not emit middleware definitions.

- [ ] **Step 3: Extend the Traefik document and projection**

Add middleware types to `src/traefik.ts`:

```typescript
type TraefikMiddleware =
  | {
      basicAuth: {
        users: string[];
        removeHeader: boolean;
      };
    }
  | {
      headers: {
        customRequestHeaders: Record<string, string>;
      };
    };

export interface TraefikDocument {
  http: {
    routers: Record<string, {
      rule: string;
      service: string;
      middlewares: string[];
    }>;
    services: Record<string, {
      loadBalancer: {
        passHostHeader: boolean;
        servers: Array<{ url: string }>;
      };
    }>;
    middlewares: Record<string, TraefikMiddleware>;
  };
}
```

Initialize middleware projection before sorting routes:

```typescript
const middlewares: TraefikDocument['http']['middlewares'] =
  config.managedBasicAuth
    ? {
        'agent-basic-auth': {
          basicAuth: {
            users: [config.managedBasicAuth.userEntry],
            removeHeader: true,
          },
        },
      }
    : {
        'agent-provider-sentinel': {
          headers: {
            customRequestHeaders: {
              'X-Route-Manager-Sentinel': '1',
            },
          },
        },
      };
```

Return all three maps:

```typescript
return { http: { routers, services, middlewares } };
```

- [ ] **Step 4: Update the existing single-route expected document**

In `tests/traefik.test.ts`, add the external sentinel under the existing expected `http` object:

```typescript
middlewares: {
  'agent-provider-sentinel': {
    headers: {
      customRequestHeaders: {
        'X-Route-Manager-Sentinel': '1',
      },
    },
  },
},
```

- [ ] **Step 5: Run projection and HTTP tests**

Run:

```bash
npx vitest run tests/traefik.test.ts tests/http.test.ts
npm run typecheck
```

Expected: projection tests PASS, provider endpoint tests accept the expanded document, and TypeScript passes.

- [ ] **Step 6: Commit middleware projection**

```bash
git add src/traefik.ts tests/traefik.test.ts
git commit -m "fix: clear final traefik route with managed middleware"
```

---

### Task 3: Verify Managed Auth End To End And Document Deployment

**Files:**
- Modify: `tests/container-smoke.sh`
- Modify: `tests/shell-syntax.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `BASIC_AUTH_PASSWORD`, managed middleware projection, and current MCP tools.
- Verifies: publish, BasicAuth HTTP, WebSocket upgrade, final-route removal, and non-root image behavior.

- [ ] **Step 1: Write failing smoke-harness regression assertions**

Append to the `container-smoke.sh` describe block in `tests/shell-syntax.test.ts`:

```typescript
it('uses route-manager-managed BasicAuth', () => {
  expect(smokeContent).toContain('-e BASIC_AUTH_PASSWORD=test');
  expect(smokeContent).not.toContain('dev-basic-auth-users');
  expect(smokeContent).not.toContain('traefik-dynamic.yml');
});

it('checks removal through the same route hostname', () => {
  expect(smokeContent).toContain('"removed route-smoke" 20 "Host: route-smoke.tiamop23.de"');
});
```

- [ ] **Step 2: Run shell tests and observe managed-mode failure**

Run:

```bash
npx vitest run tests/shell-syntax.test.ts
```

Expected: FAIL because the smoke harness still generates and mounts a file-provider BasicAuth configuration.

- [ ] **Step 3: Convert the container smoke to managed BasicAuth**

In `tests/container-smoke.sh`:

1. Delete `BASIC_AUTH_HASH` generation.
2. Remove the `providers.file` block from generated Traefik static YAML.
3. Delete generation of `traefik-dynamic.yml` and update the script comments to describe managed BasicAuth.
4. Add the managed password to route-manager startup:

```bash
-e BASIC_AUTH_PASSWORD=test \
```

5. Remove the dynamic YAML mount from Traefik startup:

```bash
-v "$TEST_DIR/traefik-dynamic.yml:/etc/traefik/dynamic.yml:ro" \
```

6. Keep the existing 401, authenticated body, WebSocket 101, and final 404 assertions unchanged. The final 404 is the regression check for Traefik no longer retaining the last route.

- [ ] **Step 4: Run static smoke checks**

Run:

```bash
bash -n tests/container-smoke.sh
npx vitest run tests/shell-syntax.test.ts
```

Expected: shell syntax and all smoke regression assertions PASS.

- [ ] **Step 5: Document managed and external authentication modes**

Add these rows to the README environment table:

```markdown
| `BASIC_AUTH_PASSWORD` | - | No | Enables route-manager-managed BasicAuth. Pass the same password used by OpenCode/code-server. Mutually exclusive with `TRAEFIK_MIDDLEWARE`. |
| `BASIC_AUTH_USERNAME` | `opencode` | No | Username for managed BasicAuth; 1-64 ASCII letters, digits, `.`, `_`, or `-`. |
```

Replace the `TRAEFIK_MIDDLEWARE` description with:

```markdown
| `TRAEFIK_MIDDLEWARE` | `dev-basic-auth@file` | No | External middleware reference used only when `BASIC_AUTH_PASSWORD` is absent. |
```

Add a `Managed BasicAuth` section containing:

````markdown
## Managed BasicAuth

For a password-based deployment, pass the same secret to OpenCode and
route-manager:

```yaml
- OPENCODE_SERVER_PASSWORD=${WORKSPACE_PASSWORD}
- BASIC_AUTH_PASSWORD=${WORKSPACE_PASSWORD}
```

Route-manager hashes the password with bcrypt cost 12 at startup and publishes
`agent-basic-auth@http`. It never stores or logs the plaintext password. Remove
`TRAEFIK_MIDDLEWARE` in managed mode. Existing Authentik or file-provider
deployments can omit `BASIC_AUTH_PASSWORD` and continue using
`TRAEFIK_MIDDLEWARE`.

The managed middleware remains in zero-route provider documents, allowing
Traefik to remove the final router without a restart.
````

Document rotation: update the shared password and recreate OpenCode,
code-server, and route-manager; Traefik updates on its next HTTP-provider poll.

- [ ] **Step 6: Run full repository verification**

Run:

```bash
npm test
npm run typecheck
npm run build
bash -n tests/container-smoke.sh
node --check tests/helpers/mcp-smoke-client.mjs
```

Expected: all tests PASS, TypeScript checks and builds, and both scripts parse.

Run on a host with a working Podman or Docker runtime:

```bash
bash tests/container-smoke.sh
```

Expected: image builds as non-root; publish returns active; unauthenticated HTTP returns 401; BasicAuth HTTP and WebSocket succeed; remove returns true; the same Host route becomes 404 after the next provider poll without restarting Traefik.

- [ ] **Step 7: Commit smoke and documentation changes**

```bash
git add README.md tests/container-smoke.sh tests/shell-syntax.test.ts
git commit -m "test: verify managed basic auth lifecycle"
```

---

## Final Review Checklist

- [ ] `git diff --check` is clean.
- [ ] `npm test` passes with no test failures.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run build` exits 0.
- [ ] `bash -n tests/container-smoke.sh` exits 0.
- [ ] `node --check tests/helpers/mcp-smoke-client.mjs` exits 0.
- [ ] No password or bcrypt hash is committed.
- [ ] Application tests verify external middleware compatibility.
- [ ] Host container smoke verifies final-route deletion without Traefik restart.
- [ ] `server-compose-stack` remains unchanged.
- [ ] Do not push or publish until the user explicitly requests it.
