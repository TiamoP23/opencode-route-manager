#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [action, slug, portText] = process.argv.slice(2);
const transport = new StreamableHTTPClientTransport(new URL(process.env.MCP_URL), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } },
});
const client = new Client({ name: 'route-manager-smoke', version: '1.0.0' });
await client.connect(transport);
const result = await client.callTool({
  name: action === 'publish' ? 'publish_service' : 'remove_service',
  arguments: action === 'publish' ? { slug, port: Number(portText) } : { slug },
});
await client.close();
if (result.isError) process.exit(1);
