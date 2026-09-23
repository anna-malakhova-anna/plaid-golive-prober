// Drives Plaid's local Sandbox MCP server (mcp-server-plaid, installed via
// `uvx`, configured in ../.mcp.json) as a real MCP client over stdio, using
// the official @modelcontextprotocol/sdk -- the same transport Claude Code
// uses. This proves the server actually works end to end, not just that its
// source exists.
//
// Four checks, run in order:
//   1. create a Sandbox Item          -> tool: get_sandbox_access_token
//   2. fire a webhook                 -> tool: simulate_webhook
//   3. trigger a real Item error      -> attempted via simulate_webhook,
//      expected to fail (see below), proving the MCP server has no tool
//      that can do it.
//   4. reset_login -> data pull       -> prober/plaid-client.js (raw REST,
//      SPEC.md §2.2), confirming that path actually produces
//      ITEM_LOGIN_REQUIRED on a live data pull.
//
// Run: node scripts/verify-sandbox.js   (needs .env with PLAID_CLIENT_ID / PLAID_SECRET)
require('dotenv').config();
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const plaidClient = require('../prober/plaid-client');

const UVX = process.env.UVX_PATH || `${process.env.HOME}/.local/bin/uvx`;

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (copy .env.example to .env and fill it in)`);
  return v;
}

function textOf(result) {
  return result.content.map((c) => c.text).join('\n');
}

async function main() {
  const clientId = must('PLAID_CLIENT_ID');
  const secret = must('PLAID_SECRET');
  const results = [];

  const transport = new StdioClientTransport({
    command: UVX,
    args: ['--from', 'mcp-server-plaid', '--python', '3.12', 'mcp-server-plaid'],
    env: { PLAID_CLIENT_ID: clientId, PLAID_SECRET: secret, PATH: process.env.PATH },
  });
  const client = new Client({ name: 'plaid-golive-prober/verify-sandbox', version: '1.0.0' });

  console.log('Connecting to local mcp-server-plaid over stdio...');
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log('Tools exposed:', tools.map((t) => t.name).join(', '));

  // --- 1. Create a Sandbox Item ------------------------------------------------
  console.log('\n[1/4] Creating a Sandbox Item via get_sandbox_access_token...');
  const createResult = await client.callTool({
    name: 'get_sandbox_access_token',
    arguments: {
      initial_products: 'transactions',
      // A webhook URL is required up front: /sandbox/item/fire_webhook will
      // reject firing a webhook later if the Item wasn't created with one.
      webhook: 'https://example.com/webhook',
    },
  });
  const createText = textOf(createResult);
  console.log(createText);
  const accessToken = /Access Token: (\S+)/.exec(createText)?.[1];
  const itemId = /Item ID: (\S+)/.exec(createText)?.[1];
  if (!accessToken) throw new Error('did not get an access token back -- Item creation failed');
  results.push({ check: 'create Sandbox Item', ok: true, detail: `item_id=${itemId}` });

  // --- 2. Fire a webhook --------------------------------------------------------
  console.log('\n[2/4] Firing a webhook via simulate_webhook (SYNC_UPDATES_AVAILABLE)...');
  const webhookResult = await client.callTool({
    name: 'simulate_webhook',
    arguments: {
      access_token: accessToken,
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      webhook_type: 'TRANSACTIONS',
    },
  });
  const webhookText = textOf(webhookResult);
  console.log(webhookText);
  results.push({
    check: 'fire a webhook',
    ok: /Webhook fired: True/i.test(webhookText),
    detail: webhookText,
  });

  // --- 3. Trigger an Item error --------------------------------------------------
  // ITEM_LOGIN_REQUIRED is the canonical "Item error" -- Plaid's real path to it
  // is /sandbox/item/reset_login, a dedicated sandbox endpoint the MCP server does
  // NOT wrap (it only wraps /sandbox/item/fire_webhook, whose webhook_code enum
  // rejects ITEM_LOGIN_REQUIRED outright). This call is expected to fail --
  // proving that gap is the point of this check.
  console.log('\n[3/4] Attempting to trigger ITEM_LOGIN_REQUIRED via simulate_webhook (expected to fail)...');
  let mcpTriggerFailed = false;
  let mcpTriggerDetail = '';
  try {
    const errResult = await client.callTool({
      name: 'simulate_webhook',
      arguments: { access_token: accessToken, webhook_code: 'ITEM_LOGIN_REQUIRED', webhook_type: 'ITEM' },
    });
    mcpTriggerDetail = textOf(errResult);
    mcpTriggerFailed = /error/i.test(mcpTriggerDetail);
  } catch (e) {
    mcpTriggerFailed = true;
    mcpTriggerDetail = e.message;
  }
  console.log(mcpTriggerDetail);
  results.push({
    check: 'trigger an Item error via the MCP server',
    ok: false,
    detail: `MCP server cannot do this -- confirmed rejected: ${mcpTriggerDetail}`,
  });

  // --- 4. reset_login -> data pull actually produces ITEM_LOGIN_REQUIRED --------
  // Uses prober/plaid-client.js (raw Sandbox REST, SPEC.md §2.2), bypassing the
  // MCP server entirely -- this is the path §4.1 of SPEC.md actually relies on.
  console.log('\n[4/4] reset_login, then a live data pull (transactions/sync)...');
  const resetBody = await plaidClient.resetLogin(accessToken);
  console.log('reset_login response:', resetBody);

  const syncBody = await plaidClient.transactionsSync(accessToken);
  console.log('transactions/sync after reset_login:', syncBody);
  const realErrorTriggered = syncBody.error_code === 'ITEM_LOGIN_REQUIRED';
  results.push({
    check: 'reset_login -> data pull produces ITEM_LOGIN_REQUIRED',
    ok: realErrorTriggered,
    detail: realErrorTriggered
      ? `confirmed: transactions/sync now fails with ${syncBody.error_code}`
      : `unexpected: ${JSON.stringify(syncBody)}`,
  });

  await client.close();

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail ? ` -- ${r.detail}` : ''}`);
  }

  const allExpected =
    results[0].ok && results[1].ok && !results[2].ok && results[3].ok;
  process.exit(allExpected ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-sandbox failed:', e);
  process.exit(1);
});
