// Webhook Delivery Failure probe (SPEC.md §4.2).
//
// No prior approach for this failure mode exists in this project's history --
// chosen and justified here, and mirrored into SPEC.md §4.2:
//
// Neither reference app's /webhook handler can be made to throw from any
// externally-supplied payload shape: both only ever touch payload fields via
// safe, optional-chained access, and Express's own body-parser already
// rejects malformed JSON with a 400 before either app's code runs at all.
// And Plaid's real webhook delivery/retry behavior can't be observed here
// without a public tunnel (SPEC.md §2.2). So instead of a bad payload, this
// probe injects a downstream fault: it makes the app's data directory
// unwritable immediately before delivering a well-formed webhook, so
// PROCESSING genuinely fails partway through (store.js's fs.writeFileSync
// throws) -- a realistic production fault (disk full, DB down, etc.), not a
// contrived input. It checks whether that failure is signaled correctly (a
// non-2xx response, so Plaid's real retry contract would kick in) or
// swallowed (silently ACKed 200, so Plaid never retries and the event is
// lost for good).
//
// Split into two checks:
//   4.2.1 Processing Failure Signaling -- does the app's HTTP response tell
//     the truth when processing genuinely fails?
//   4.2.2 Redelivery Recovery -- reframed away from "does Plaid actually
//     redeliver" (a live-infrastructure question this environment can't
//     answer, SPEC.md §2.2 / §4.2.2's manual-verification note) to "if a
//     webhook IS redelivered once the fault clears, does the app correctly
//     recover?" The probe plays sender for that second delivery itself,
//     the same substitution §4.3.2 makes for an unobservable platform fact.
//
// Usage: node probes/webhook-delivery-failure.js <baseUrl> <dataDirPath>

const fs = require('fs');
const path = require('path');
const { severityOf, isBlocker } = require('./severity');

const FAILURE_MODE = 'Webhook Delivery Failure';

// Makes writes to the app's storage fail. Chmod'ing the directory alone is
// NOT sufficient once state.json already exists: overwriting an existing
// file's contents only requires write permission on the file itself --
// directory permissions only gate creating/deleting/renaming entries. Must
// chmod the file too when present, or the "fault" silently no-ops.
function injectStorageFault(dataDirPath) {
  const statePath = path.join(dataDirPath, 'state.json');
  const original = {
    dir: fs.statSync(dataDirPath).mode,
    file: fs.existsSync(statePath) ? fs.statSync(statePath).mode : null,
  };
  fs.chmodSync(dataDirPath, 0o500); // read + execute only, no write
  if (original.file !== null) fs.chmodSync(statePath, 0o400); // read-only
  return function restore() {
    fs.chmodSync(dataDirPath, original.dir);
    if (original.file !== null) fs.chmodSync(statePath, original.file);
  };
}

async function checkProcessingFailureSignaling(baseUrl, dataDirPath) {
  const payload = {
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    item_id: 'probe-item-webhook-delivery-failure',
  };

  const restore = injectStorageFault(dataDirPath);

  let httpStatus;
  let httpBody;
  try {
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    httpStatus = res.status;
    httpBody = await res.text();
  } finally {
    // Always restore, even if the fetch itself throws.
    restore();
  }

  const stateAfter = await (await fetch(`${baseUrl}/state`)).json();

  // "Handled" means the app's HTTP response tells the truth about whether
  // processing worked -- a non-2xx on genuine failure is what lets Plaid's
  // real delivery contract (retry on non-200) do its job.
  const signaledFailure = httpStatus >= 400;
  const classification = signaledFailure ? 'handled' : 'unhandled';

  const rationale = signaledFailure
    ? `the app returned HTTP ${httpStatus} when webhook processing genuinely failed (storage was unwritable) -- Plaid's real delivery contract retries on any non-200 response, so this webhook would be redelivered.`
    : `the app returned HTTP ${httpStatus} (ACKed success) even though processing failed (storage was unwritable) -- Plaid's real delivery contract only retries on non-200, so it will never redeliver this webhook. The event is silently lost.`;

  const severity = severityOf(FAILURE_MODE);
  return {
    failure_mode: FAILURE_MODE,
    what_was_fired: `POST ${baseUrl}/webhook with the app's data directory made unwritable (simulated processing fault), payload: ${JSON.stringify(payload)}`,
    observed_response: { http_status: httpStatus, http_body: httpBody, state_after: stateAfter },
    classification,
    severity,
    is_blocker: isBlocker(severity),
    rationale: `[4.2.1 Processing Failure Signaling] ${rationale}`,
    // The fault is injected directly against the app under test, not
    // simulated through Plaid Sandbox -- there's no Sandbox condition here
    // to diverge from Production.
    sandbox_fidelity: 'matches_production',
    not_observable_reason: null,
  };
}

async function checkRedeliveryRecovery(baseUrl, dataDirPath) {
  const payload = {
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    item_id: 'probe-item-webhook-delivery-failure-retry',
  };

  // First delivery: same fault injection as §4.2.1, so this attempt fails.
  const restore = injectStorageFault(dataDirPath);
  try {
    await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } finally {
    restore();
  }

  // Second delivery: fault cleared. The probe plays sender here rather than
  // waiting on a real Plaid redelivery -- see file header for why.
  const res2 = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const secondStatus = res2.status;
  const stateAfter = await (await fetch(`${baseUrl}/state`)).json();

  const recovered = secondStatus >= 200 && secondStatus < 300 && stateAfter.item?.syncAvailable === true;
  const classification = recovered ? 'handled' : 'unhandled';

  const rationale = recovered
    ? `the redelivered webhook succeeded (HTTP ${secondStatus}) once the transient fault cleared, and its effect (item.syncAvailable) is reflected in /state -- the app recovers correctly from a prior failed attempt.`
    : `the redelivered webhook did not succeed cleanly (HTTP ${secondStatus}, item.syncAvailable: ${stateAfter.item?.syncAvailable}) even after the transient fault cleared -- the app does not recover correctly from a prior failed attempt.`;

  const severity = severityOf(FAILURE_MODE);
  return {
    failure_mode: FAILURE_MODE,
    what_was_fired: `POST ${baseUrl}/webhook (fault injected, expect failure), fault cleared, POST ${baseUrl}/webhook again with the identical payload: ${JSON.stringify(payload)}`,
    observed_response: { second_delivery_status: secondStatus, state_after: stateAfter },
    classification,
    severity,
    is_blocker: isBlocker(severity),
    rationale: `[4.2.2 Redelivery Recovery] ${rationale} This does not verify that Plaid actually redelivers on a non-200 in Production -- see the manual-verification note in SPEC.md §4.2.2.`,
    // The recovery behavior tested here is entirely local (fault injection
    // + the app's own retry handling) -- no Sandbox condition to diverge
    // from Production.
    sandbox_fidelity: 'matches_production',
    not_observable_reason: null,
  };
}

async function runWebhookDeliveryFailureProbe({ baseUrl, dataDirPath }) {
  const signaling = await checkProcessingFailureSignaling(baseUrl, dataDirPath);
  const recovery = await checkRedeliveryRecovery(baseUrl, dataDirPath);
  return [signaling, recovery];
}

module.exports = { runWebhookDeliveryFailureProbe };

if (require.main === module) {
  const [baseUrl, dataDirPath] = process.argv.slice(2);
  if (!baseUrl || !dataDirPath) {
    console.error('usage: node probes/webhook-delivery-failure.js <baseUrl> <dataDirPath>');
    process.exit(1);
  }
  require('dotenv').config();
  runWebhookDeliveryFailureProbe({ baseUrl, dataDirPath })
    .then((results) => console.log(JSON.stringify(results, null, 2)))
    .catch((e) => {
      console.error('probe failed:', e);
      process.exit(1);
    });
}
