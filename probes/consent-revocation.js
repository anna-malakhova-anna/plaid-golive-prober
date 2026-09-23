// Consent Revocation probe (SPEC.md §4.3).
//
// Split into two independent checks per SPEC.md §4.3:
//   4.3.1 Handler Reaction     -- does the app's own /webhook endpoint react
//                                 correctly to a USER_PERMISSION_REVOKED
//                                 payload (a distinct, permanent status)?
//   4.3.2 Pull-Stop Enforcement -- once it knows that, does the app actually
//                                 stop pulling data on that Item, the same
//                                 signal as the re-auth check (SPEC.md §4.1)?
//
// Neither check touches Plaid. Items created through either app's own
// /items endpoint carry no webhook URL (and even if they did, Plaid can't
// deliver to a local, non-tunneled endpoint -- SPEC.md §2.2), so there is no
// way to get a REAL Plaid-delivered webhook to a locally running app. Both
// checks instead drive the app directly: a synthetic, Plaid-shaped payload
// POSTed to /webhook, then the app's own endpoints.
//
// Whether Plaid's Sandbox API itself would ever start rejecting calls on a
// revoked Item is a separate, already-answered platform question (SPEC.md
// §4.3.2 note): Sandbox does not mutate Item state on revocation at all, so
// there's nothing to poll for there. That's why §4.3.2 here checks the
// app's own defensive behavior (does it stop calling Plaid once it's been
// told consent is gone) rather than re-deriving that platform fact on every
// run -- and why sandbox_fidelity stays 'diverges' even when this check
// passes: passing only proves the app's own circuit breaker works, not that
// Production's real enforcement would also be caught if that breaker were
// somehow wrong, since Sandbox provides no way to test that combination.
//
// Usage: node probes/consent-revocation.js <baseUrl>

const { severityOf, isBlocker } = require('./severity');

const FAILURE_MODE = 'Consent Revocation';

async function checkHandlerReaction(baseUrl) {
  const payload = {
    webhook_type: 'ITEM',
    webhook_code: 'USER_PERMISSION_REVOKED',
    item_id: 'probe-item-consent-revocation',
  };

  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const httpStatus = res.status;
  const observed = await (await fetch(`${baseUrl}/state`)).json();

  const status = observed.item?.status;
  // "Handled" means the app treats revocation as its own permanent
  // condition, distinct from the recoverable 'login_required' it uses for
  // an expired login -- no re-auth flow can undo a user's revoked consent.
  const classification = status === 'revoked' ? 'handled' : 'unhandled';

  const rationale =
    classification === 'handled'
      ? "item.status is 'revoked', distinct from the recoverable 'login_required' state -- the app correctly treats consent revocation as permanent and would prompt a fresh Link flow rather than a re-auth."
      : `item.status is '${status}' after a USER_PERMISSION_REVOKED payload -- ${
          status === 'login_required'
            ? "collapsed into the same recoverable state used for an expired login, which is wrong: no re-auth can undo a user's revoked consent."
            : 'not distinguishable as a permanent, revoked condition.'
        }`;

  const severity = severityOf(FAILURE_MODE);
  return {
    failure_mode: FAILURE_MODE,
    what_was_fired: `POST ${baseUrl}/webhook (synthetic, Plaid-shaped payload -- a real Plaid-delivered webhook isn't reachable here, see file header): ${JSON.stringify(payload)}`,
    observed_response: { http_status: httpStatus, state: observed },
    classification,
    severity,
    is_blocker: isBlocker(severity),
    rationale: `[4.3.1 Handler Reaction] ${rationale}`,
    // The app's reaction to a payload shape doesn't depend on Sandbox at all.
    sandbox_fidelity: 'matches_production',
    not_observable_reason: null,
  };
}

async function checkPullStopEnforcement(baseUrl) {
  // A fresh Item through the app's own endpoint -- we're checking THIS
  // app's pull-stop behavior, same pattern as SPEC.md §4.1's probe.
  const createRes = await fetch(`${baseUrl}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!createRes.ok) {
    throw new Error(`could not create an Item on ${baseUrl}: ${createRes.status} ${await createRes.text()}`);
  }

  const payload = {
    webhook_type: 'ITEM',
    webhook_code: 'USER_PERMISSION_REVOKED',
    item_id: 'probe-item-consent-revocation-enforcement',
  };
  await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  // The actual question: once the app knows this Item's consent was
  // revoked, does it stop calling Plaid on it?
  await fetch(`${baseUrl}/transactions/sync`, { method: 'POST' });

  const observed = await (await fetch(`${baseUrl}/state`)).json();
  const mostRecentAttempt = observed.pullAttempts?.[0];
  const pullsStopped = mostRecentAttempt?.reachedPlaid === false;
  const classification = pullsStopped ? 'handled' : 'unhandled';

  const rationale = pullsStopped
    ? 'the data-pull attempt right after the revocation webhook was skipped (reachedPlaid: false) -- the app stopped calling Plaid once it knew consent was revoked.'
    : `the data-pull attempt right after the revocation webhook still reached Plaid (reachedPlaid: ${mostRecentAttempt?.reachedPlaid}) -- the app keeps calling Plaid on an Item it was just told is permanently revoked.`;

  const severity = severityOf(FAILURE_MODE);
  return {
    failure_mode: FAILURE_MODE,
    what_was_fired: `POST ${baseUrl}/items, then POST ${baseUrl}/webhook (${JSON.stringify(payload)}), then POST ${baseUrl}/transactions/sync`,
    observed_response: observed,
    classification,
    severity,
    is_blocker: isBlocker(severity),
    rationale: `[4.3.2 Pull-Stop Enforcement] ${rationale} Sandbox itself never mutates Item state on revocation (SPEC.md §4.3.2 note) -- so this only verifies the app's own defensive pull-stop logic in reaction to the webhook signal, not that Production's real enforcement would also be caught if that logic were somehow wrong.`,
    sandbox_fidelity: 'diverges',
    not_observable_reason: null,
  };
}

async function runConsentRevocationProbe({ baseUrl }) {
  const handlerReaction = await checkHandlerReaction(baseUrl);
  const pullStopEnforcement = await checkPullStopEnforcement(baseUrl);
  return [handlerReaction, pullStopEnforcement];
}

module.exports = { runConsentRevocationProbe };

if (require.main === module) {
  const [baseUrl] = process.argv.slice(2);
  if (!baseUrl) {
    console.error('usage: node probes/consent-revocation.js <baseUrl>');
    process.exit(1);
  }
  require('dotenv').config();
  runConsentRevocationProbe({ baseUrl })
    .then((results) => console.log(JSON.stringify(results, null, 2)))
    .catch((e) => {
      console.error('probe failed:', e);
      process.exit(1);
    });
}
