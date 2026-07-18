import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const smokeScript = join(process.cwd(), 'tests', 'container-smoke.sh');

describe('container-smoke.sh', () => {
  it('passes bash syntax check (bash -n)', () => {
    // bash -n parses the script without executing it.
    // A non-zero exit or syntax error in stderr means the shell
    // rejects the script.
    const result = execFileSync('bash', ['-n', smokeScript], {
      encoding: 'utf8',
      timeout: 5000,
    });
    // No news is good news — execFileSync throws on non-zero.
    expect(result).toBe('');
  });
});
