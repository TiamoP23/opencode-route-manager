import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

let scenario = 'publish-mismatch';
let closeCallCount = 0;
let lastCallToolArgs = null;

function setScenario(next) {
  scenario = next;
  closeCallCount = 0;
  lastCallToolArgs = null;
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async callTool(args) {
      lastCallToolArgs = args;
      if (scenario === 'publish-success') {
        return {
          isError: false,
          structuredContent: {
            service: { slug: 'demo', port: 5173, status: 'active' },
            url: 'https://demo.example.dev',
          },
        };
      }
      if (scenario === 'remove-success') {
        return {
          isError: false,
          structuredContent: { slug: 'demo', removed: true },
        };
      }
      if (scenario === 'tool-error') {
        return { isError: true };
      }
      if (scenario === 'remove-mismatch') {
        return {
          isError: false,
          structuredContent: { slug: 'wrong-slug', removed: false },
        };
      }
      // Default: publish mismatch so validation fails.
      return {
        isError: false,
        structuredContent: {
          service: { slug: 'wrong-slug', port: 9999, status: 'active' },
          url: 'https://wrong-slug.example.dev',
        },
      };
    }
    async close() {
      closeCallCount += 1;
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor() {}
  },
}));

describe('mcp-smoke-client.mjs cleanup-safe control flow', () => {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  let exitSpy;

  beforeAll(() => {
    process.env.MCP_URL = 'http://localhost:9999';
    process.env.MCP_TOKEN = 'test-token';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterAll(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
    exitSpy.mockRestore();
  });

  beforeEach(() => {
    exitSpy.mockClear();
  });

  it('closes the MCP client before exiting when publish validation fails', async () => {
    setScenario('publish-mismatch');
    process.argv = ['node', 'tests/helpers/mcp-smoke-client.mjs', 'publish', 'demo', '5173'];
    await import('../tests/helpers/mcp-smoke-client.mjs?test=publish-fail');

    expect(lastCallToolArgs).toEqual({ name: 'publish_service', arguments: { slug: 'demo', port: 5173 } });
    expect(closeCallCount).toBe(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('closes the MCP client before exiting when remove validation fails', async () => {
    setScenario('remove-mismatch');
    process.argv = ['node', 'tests/helpers/mcp-smoke-client.mjs', 'remove', 'demo'];
    await import('../tests/helpers/mcp-smoke-client.mjs?test=remove-fail');

    expect(lastCallToolArgs).toEqual({ name: 'remove_service', arguments: { slug: 'demo' } });
    expect(closeCallCount).toBe(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('closes the MCP client and exits 1 on a tool-level error response', async () => {
    setScenario('tool-error');
    process.argv = ['node', 'tests/helpers/mcp-smoke-client.mjs', 'publish', 'demo', '5173'];
    await import('../tests/helpers/mcp-smoke-client.mjs?test=tool-error');

    expect(closeCallCount).toBe(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('closes the MCP client and exits 0 on a matching publish response', async () => {
    setScenario('publish-success');
    process.argv = ['node', 'tests/helpers/mcp-smoke-client.mjs', 'publish', 'demo', '5173'];
    await import('../tests/helpers/mcp-smoke-client.mjs?test=publish-ok');

    expect(closeCallCount).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('closes the MCP client and exits 0 on a matching remove response', async () => {
    setScenario('remove-success');
    process.argv = ['node', 'tests/helpers/mcp-smoke-client.mjs', 'remove', 'demo'];
    await import('../tests/helpers/mcp-smoke-client.mjs?test=remove-ok');

    expect(closeCallCount).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
