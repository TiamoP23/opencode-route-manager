import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const smokeScript = join(process.cwd(), 'tests', 'container-smoke.sh');
const smokeContent = readFileSync(smokeScript, 'utf8');

const HOST_HEADER = 'Host: route-smoke.tiamop23.de';

describe('container-smoke.sh', () => {
  it('passes bash syntax check (bash -n)', () => {
    execFileSync('bash', ['-n', smokeScript], {
      encoding: 'utf8',
      timeout: 5000,
    });
  });

  describe('Host-header regression — each Traefik route assertion sends the route hostname', () => {
    // Before commit 7664463 the unauthenticated (7e), authenticated (7f), and
    // removal (7i) polls omitted the Host header.  Traefik's Host-based router
    // would never match route-smoke.tiamop23.de, so the 401/200/404 assertions
    // exercised the default/no-match router instead of the actual published
    // route.  These tests fail if any of the three curl calls lose their
    // Host header argument.

    it('unauthenticated Traefik route check (7e) sends Host header', () => {
      // Step 7e: poll_url for 401 with Host header
      const noAuthLine = 'poll_url "http://127.0.0.1:${TRAEFIK_PORT}" 401 \\';
      const noAuthHost = `"route-smoke.tiamop23.de (no auth)" 15 "${HOST_HEADER}"`;
      expect(smokeContent).toContain(noAuthLine);
      expect(smokeContent).toContain(noAuthHost);
    });

    it('authenticated Traefik route check (7f) sends Host header', () => {
      // Step 7f: poll_body with BasicAuth and Host header
      const authHost = `"route-smoke.tiamop23.de (BasicAuth)" 15 "${HOST_HEADER}"`;
      expect(smokeContent).toContain(authHost);
    });

    it('removal 404 check (7i) exercises the removed hostname', () => {
      // Step 7i: poll_url for 404 on the removed route-smoke hostname
      const removalHost = `"removed route-smoke" 20 "${HOST_HEADER}"`;
      expect(smokeContent).toContain(removalHost);
    });
  });

  it('uses route-manager-managed BasicAuth', () => {
    expect(smokeContent).toContain('-e BASIC_AUTH_PASSWORD=test \\');
    expect(smokeContent).not.toContain('dev-basic-auth-users');
    expect(smokeContent).not.toContain('traefik-dynamic.yml');
  });

  it('checks removal through the same route hostname', () => {
    expect(smokeContent).toContain('"removed route-smoke" 20 "Host: route-smoke.tiamop23.de"');
  });
});
