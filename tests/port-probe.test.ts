import { describe, expect, it, onTestFailed } from 'vitest';
import { createServer, type Server } from 'node:net';
import { probeTcpPort } from '../src/port-probe.js';

async function withServer(
  port: number,
  fn: (server: Server) => Promise<void>,
): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    await fn(server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('probeTcpPort', () => {
  it('returns true for a listening port', async () => {
    await withServer(0, async (server) => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');
      const result = await probeTcpPort('127.0.0.1', addr.port, 1000);
      expect(result).toBe(true);
    });
  });

  it('returns false for a closed port', async () => {
    // Use port 0 to get an ephemeral port, close it, then probe it
    const probePort = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        if (!addr || typeof addr === 'string') {
          s.close();
          reject(new Error('unexpected address'));
          return;
        }
        const p = addr.port;
        s.close(() => resolve(p));
      });
    });

    const result = await probeTcpPort('127.0.0.1', probePort, 1000);
    expect(result).toBe(false);
  });

  it('settles within the supplied timeout for a listening port', async () => {
    await withServer(0, async (server) => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');
      const start = Date.now();
      const result = await probeTcpPort('127.0.0.1', addr.port, 500);
      const elapsed = Date.now() - start;
      expect(result).toBe(true);
      expect(elapsed).toBeLessThan(2000); // generous tolerance
    });
  });

  it('settles within the supplied timeout for a closed port', async () => {
    const probePort = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        if (!addr || typeof addr === 'string') {
          s.close();
          reject(new Error('unexpected address'));
          return;
        }
        const p = addr.port;
        s.close(() => resolve(p));
      });
    });

    const start = Date.now();
    const result = await probeTcpPort('127.0.0.1', probePort, 500);
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });
});
