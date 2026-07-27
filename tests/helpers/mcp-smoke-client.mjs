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
let validationError = null;
let resultToLog = null;
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
      validationError = 'publish_service response missing structuredContent';
    } else {
      const { service, url } = result.structuredContent;
      if (service?.slug !== slug) {
        validationError = `expected published slug "${slug}", got "${service?.slug}"`;
      } else if (service?.port !== expectedPort) {
        validationError = `expected published port ${expectedPort}, got ${service?.port}`;
      } else if (service?.status !== 'active') {
        validationError = `expected published status active, got "${service?.status}"`;
      } else if (!url || !url.includes(slug)) {
        validationError = `expected public URL containing "${slug}", got "${url}"`;
      } else {
        resultToLog = result.structuredContent;
      }
    }
  } else {
    if (!result.structuredContent) {
      validationError = 'remove_service response missing structuredContent';
    } else {
      const { slug: removedSlug, removed } = result.structuredContent;
      if (removedSlug !== slug) {
        validationError = `expected removed slug "${slug}", got "${removedSlug}"`;
      } else if (removed !== true) {
        validationError = `expected removed:true, got ${removed}`;
      } else {
        resultToLog = result.structuredContent;
      }
    }
  }
} finally {
  await client.close().catch(() => {});
}
if (resultToLog) {
  console.log(JSON.stringify(resultToLog));
}
if (toolFailed) {
  process.exit(1);
}
if (validationError) {
  fail(validationError);
}
