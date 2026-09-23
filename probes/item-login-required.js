// ITEM_LOGIN_REQUIRED probe (SPEC.md §4.1).
//
// Forces a real ITEM_LOGIN_REQUIRED error onto a target app's own Sandbox
// Item via /sandbox/item/reset_login (SPEC.md §2.2 -- the MCP server can't
// do this: /sandbox/item/fire_webhook rejects that code outright), then
// drives the app's own data-pull endpoint so the app's OWN error-handling
// code runs, and reads back what the app reports about itself to classify
// whether it reacted correctly.
//
// SPEC.md §4.1 defines "handled" as requiring BOTH signals:
//   1. item.status becomes a distinct 'login_required', not a generic error.
//   2. Data-pull attempts stop once that's known -- a second data-pull call
//      must not reach Plaid again.
// This probe checks both: it calls the app's data-pull endpoint a second
// time after the error and reads the app's pull-attempt log to see whether
// that second call actually reached Plaid or was skipped.
//
// Usage: node probes/item-login-required.js <baseUrl> <stateFilePath>

const fs = require('fs');
const plaidClient = require('../prober/plaid-client');
const { severityOf, isBlocker } = require('./severity');

const FAILURE_MODE = 'ITEM_LOGIN_REQUIRED';

async function runItemLoginRequiredProbe({ baseUrl, statePath }) {
  // 1. Create an Item the normal way, through the target app's own endpoint --
  //    the probe never brings its own Item, since it's testing THIS app's
  //    real integration.
  const createRes = await fetch(`${baseUrl}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!createRes.ok) {
    throw new Error(`could not create an Item on ${baseUrl}: ${createRes.status} ${await createRes.text()}`);
  }

  // 2. Read the access token straight out of the app's own persisted state.
  //    This is test-harness access to the app's storage, not a public API --
  //    the app correctly never exposes this token over HTTP (see
  //    reference-app's store.js getPublicState()).
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const accessToken = persisted.item?.accessToken;
  if (!accessToken) throw new Error(`no access token found in ${statePath} after Item creation`);

  // 3. Force the real error via raw Sandbox REST (SPEC.md §2.2).
  const whatWasFired = 'POST /sandbox/item/reset_login';
  const resetResult = await plaidClient.resetLogin(accessToken);
  if (!resetResult.reset_login) {
    throw new Error(`reset_login did not report success: ${JSON.stringify(resetResult)}`);
  }

  // 4. Drive the app's own data-pull endpoint so ITS error-handling code
  //    runs (not the probe's). This first call is what's expected to fail
  //    and flip the Item's status.
  await fetch(`${baseUrl}/transactions/sync`, { method: 'POST' });

  // 5. Drive it a SECOND time. This is signal 2: a handled app must not
  //    reach out to Plaid again on an Item it already knows is broken.
  await fetch(`${baseUrl}/transactions/sync`, { method: 'POST' });

  // 6. Read back what the app now reports about itself.
  const observed = await (await fetch(`${baseUrl}/state`)).json();

  // 7. Classify. "Handled" requires BOTH signals (SPEC.md §4.1):
  //      a) item.status is a distinct 'login_required', not a generic error.
  //      b) the most recent pull attempt did not reach Plaid -- pulls stopped.
  const status = observed.item?.status;
  const errorLogged = observed.errors?.some((e) => e.error_code === 'ITEM_LOGIN_REQUIRED');
  const statusIsDistinct = status === 'login_required';
  const mostRecentAttempt = observed.pullAttempts?.[0];
  const pullsStopped = mostRecentAttempt?.reachedPlaid === false;
  const classification = statusIsDistinct && pullsStopped ? 'handled' : 'unhandled';

  const rationale = [
    statusIsDistinct
      ? "signal 1 (distinct status): item.status is 'login_required', distinct from a generic error -- callers can tell this Item specifically needs the user to re-auth via Link's update mode."
      : `signal 1 (distinct status) FAILED: item.status is '${status}', indistinguishable from any other failure. The error log ${errorLogged ? 'does' : 'does not'} record error_code ITEM_LOGIN_REQUIRED, but that detail never reaches item.status.`,
    pullsStopped
      ? 'signal 2 (pulls stop): the second data-pull attempt was skipped (reachedPlaid: false) -- the app stopped calling Plaid once it knew the Item needed re-auth.'
      : `signal 2 (pulls stop) FAILED: the second data-pull attempt still reached Plaid (reachedPlaid: ${mostRecentAttempt?.reachedPlaid}) -- the app keeps burning API calls against an Item it already knows is broken.`,
  ].join(' ');

  const severity = severityOf(FAILURE_MODE);

  return {
    failure_mode: FAILURE_MODE,
    what_was_fired: whatWasFired,
    observed_response: observed,
    classification,
    severity,
    is_blocker: isBlocker(severity),
    rationale,
    // reset_login genuinely mutates Item state the way Production does when
    // a user's credentials actually go stale -- unlike consent revocation
    // (SPEC.md §4.3.2), Sandbox doesn't diverge here.
    sandbox_fidelity: 'matches_production',
    not_observable_reason: null,
  };
}

module.exports = { runItemLoginRequiredProbe };

if (require.main === module) {
  const [baseUrl, statePath] = process.argv.slice(2);
  if (!baseUrl || !statePath) {
    console.error('usage: node probes/item-login-required.js <baseUrl> <stateFilePath>');
    process.exit(1);
  }
  require('dotenv').config();
  runItemLoginRequiredProbe({ baseUrl, statePath })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((e) => {
      console.error('probe failed:', e);
      process.exit(1);
    });
}
