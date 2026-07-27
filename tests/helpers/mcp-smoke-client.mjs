#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const mcpUrl = process.env.MCP_URL;
const mcpToken = process.env.MCP_TOKEN;
if (!mcpUrl) fail('MCP_URL environment variable is required');
if (!mcpToken) fail('MCP_TOKEN environment variable is required');

const action = process.argv[2];
const slug = process.argv[3];
const portText = process.argv[4];

if (!action) fail('action argument is required (publish|remove)');
if (action !== 'publish' && action !== 'remove') {
  fail(`unknown action "${action}" — expected publish or remove`);
}
if (!slug) fail('slug argument is required');

let toolArgs;
let expectedPort;
if (action === 'publish') {
  if (!portText) fail('port argument is required for publish');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`port must be an integer between 1 and 65535, got "${portText}"`);
  }
  toolArgs = { slug, port };
  expectedPort = port;
} else {
  toolArgs = { slug };
}

const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: {
    headers: { Authorization: `Bearer ${mcpToken}` },
  },
});
const client = new Client({ name: 'route-manager-smoke', version: '1.0.0' });

let toolFailed = false;
try {
  await client.connect(transport);
  const result = await client.callTool({
    name: action === 'publish' ? 'publish_service' : 'remove_service',
    arguments: toolArgs,
  });
  if (result.isError) {
    toolFailed = true;
  } else if (action === 'publish') {
    if (!result.structuredContent) {
      fail('publish_service response missing structuredContent');
    }
    const { service, url } = result.structuredContent;
    if (service?.slug !== slug) {
      fail(`expected published slug "${slug}", got "${service?.slug}"`);
    }
    if (service?.port !== expectedPort) {
      fail(`expected published port ${expectedPort}, got ${service?.port}`);
    }
    if (service?.status !== 'active') {
      fail(`expected published status active, got "${service?.status}"`);
    }
    if (!url || !url.includes(slug)) {
      fail(`expected public URL containing "${slug}", got "${url}"`);
    }
    console.log(JSON.stringify(result.structuredContent));
  } else {
    if (!result.structuredContent) {
      fail('remove_service response missing structuredContent');
    }
    const { slug: removedSlug, removed } = result.structuredContent;
    if (removedSlug !== slug) {
      fail(`expected removed slug "${slug}", got "${removedSlug}"`);
    }
    if (removed !== true) {
      fail(`expected removed:true, got ${removed}`);
    }
    console.log(JSON.stringify(result.structuredContent));
  }
} finally {
  await client.close().catch(() => {});
}
if (toolFailed) process.exit(1);
