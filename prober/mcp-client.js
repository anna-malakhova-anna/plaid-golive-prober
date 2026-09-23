// Shared helper for driving Plaid's local Sandbox MCP server as a client
// (SPEC.md §2.1, .mcp.json) -- the same transport scripts/verify-sandbox.js
// uses. Spawns the server over stdio for the duration of `fn`, then always
// closes it.

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const UVX = process.env.UVX_PATH || `${process.env.HOME}/.local/bin/uvx`;

function textOf(result) {
  return result.content.map((c) => c.text).join('\n');
}

async function withMcpClient(fn) {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be set in the environment');
  }

  const transport = new StdioClientTransport({
    command: UVX,
    args: ['--from', 'mcp-server-plaid', '--python', '3.12', 'mcp-server-plaid'],
    env: { PLAID_CLIENT_ID: clientId, PLAID_SECRET: secret, PATH: process.env.PATH },
  });
  const client = new Client({ name: 'plaid-golive-prober', version: '1.0.0' });

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

module.exports = { withMcpClient, textOf };
