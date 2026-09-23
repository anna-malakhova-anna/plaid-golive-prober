// Buckets a probe result into the go-live cut-line report's categories.
//
// Combines `classification` (does the app handle this failure mode, per its
// SPEC.md §4 definition?) with `is_blocker` (a declared property of the
// failure mode, SPEC.md §3 -- derived via probes/severity.js's isBlocker(),
// not re-derived here) into exactly the buckets the report needs:
//
//   blocker      -- unhandled AND the failure mode is declared high-severity.
//                   Must be fixed before go-live.
//   fast_follow  -- unhandled but low-severity. Worth fixing, not blocking.
//   not_observable -- can't be verified in this environment at all
//                   (see result.not_observable_reason for why).
//   passing      -- handled. Not part of the cut line; reported only as a
//                   count, not itemized, per the report's scope.
function bucketForReport(result) {
  if (result.classification === 'not_observable') return 'not_observable';
  if (result.classification === 'unhandled') {
    return result.is_blocker ? 'blocker' : 'fast_follow';
  }
  return 'passing';
}

module.exports = { bucketForReport };
