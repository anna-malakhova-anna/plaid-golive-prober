// Thin wrapper over the Sandbox REST endpoints the Plaid MCP server doesn't
// reach (see SPEC.md §2.2): reset_login, item/get, transactions/sync.
//
// Credentials are read from PLAID_CLIENT_ID / PLAID_SECRET at call time --
// never hardcoded, never accepted as parameters, so a client_id/secret can't
// end up in a probe result or a log line by accident.
//
// Every call returns Plaid's parsed JSON response body as-is, success or
// error alike -- a Plaid API error is still a well-formed body (error_code,
// error_type, error_message, ...), and the caller is often deliberately
// probing for one. This wrapper only throws for a genuine transport failure
// (network error, non-JSON response); it does not interpret error_code.

const SANDBOX_BASE = 'https://sandbox.plaid.com';

function credentials() {
  const client_id = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!client_id || !secret) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be set in the environment');
  }
  return { client_id, secret };
}

async function post(path, body) {
  const res = await fetch(`${SANDBOX_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...credentials(), ...body }),
  });
  return res.json();
}

// Forces an Item into ITEM_LOGIN_REQUIRED. The only way to trigger a real
// Item error -- Plaid's fire_webhook rejects ITEM_LOGIN_REQUIRED outright.
function resetLogin(accessToken) {
  return post('/sandbox/item/reset_login', { access_token: accessToken });
}

// Reads an Item's real, API-observable state (its `error` field included).
function itemGet(accessToken) {
  return post('/item/get', { access_token: accessToken });
}

// Pulls transactions. Also doubles as the "is this Item actually broken"
// probe: a failure here reflects what a live data pull would hit, as
// opposed to a webhook notification that may not correspond to real state.
function transactionsSync(accessToken, cursor) {
  return post('/transactions/sync', { access_token: accessToken, cursor });
}

module.exports = { resetLogin, itemGet, transactionsSync };
