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
