// Severity is a declared property of each failure mode (SPEC.md §4) -- fixed
// per failure mode, independent of what any single probe run classifies.
// is_blocker is derived from it, never stored separately, so it can't drift
// out of sync with the declared severity.

const SEVERITY_BY_FAILURE_MODE = {
  ITEM_LOGIN_REQUIRED: 'high',
  'Consent Revocation': 'high',
  'Webhook Delivery Failure': 'low',
};

function severityOf(failureMode) {
  const severity = SEVERITY_BY_FAILURE_MODE[failureMode];
  if (!severity) {
    throw new Error(`no declared severity for failure mode '${failureMode}' -- add it to SEVERITY_BY_FAILURE_MODE and to its SPEC.md §4 section`);
  }
  return severity;
}

// is_blocker: true whenever the failure mode's declared severity is high,
// regardless of this run's classification -- it describes how bad the
// failure mode is if it happens, not whether it happened this time.
function isBlocker(severity) {
  return severity === 'high';
}

module.exports = { severityOf, isBlocker };
