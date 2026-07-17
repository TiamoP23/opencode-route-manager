import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { probeTcpPort } from '../src/port-probe.js';

/**
 * Mock socket that never emits connect or error.
 * The test manually triggers 'timeout' to simulate
 * a socket that silently times out.
 */
let mockSocket: {
  on: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emitTimeout: () => void;
} | null = null;

vi.mock('node:net', () => {
  // Track registered handlers so we can emit timeout
  let connectHandler: (() => void) | null = null;
  let errorHandler: (() => void) | null = null;
  let timeoutHandler: (() => void) | null = null;

  return {
    createConnection: vi.fn(() => {
      const socket = {
        on: vi.fn((event: string, fn: () => void) => {
          if (event === 'connect') connectHandler = fn;
          if (event === 'timeout') timeoutHandler = fn;
          if (event === 'error') errorHandler = fn;
          return socket;
        }),
        setTimeout: vi.fn(),
        destroy: vi.fn(() => {
          connectHandler = null;
          timeoutHandler = null;
          errorHandler = null;
        }),
      };
      mockSocket = {
        ...socket,
        emitTimeout: () => { timeoutHandler?.(); },
      };
      return socket;
    }),
  };
});

beforeEach(() => {
  mockSocket = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('probeTcpPort timeout path', () => {
  it('returns false when socket times out', async () => {
    const probePromise = probeTcpPort('127.0.0.1', 9999, 500);

    // The probe should have registered its handlers by now
    expect(mockSocket).not.toBeNull();
    expect(mockSocket!.setTimeout).toHaveBeenCalledWith(500);

    // Simulate the timeout
    mockSocket!.emitTimeout();

    const result = await probePromise;
    expect(result).toBe(false);
  });

  it('destroyes the socket upon timeout', async () => {
    const probePromise = probeTcpPort('127.0.0.1', 9999, 500);

    mockSocket!.emitTimeout();
    await probePromise;

    expect(mockSocket!.destroy).toHaveBeenCalled();
  });
});
