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
