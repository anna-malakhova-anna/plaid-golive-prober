// Generates the go-live cut-line Markdown report from a probe-results JSON
// file (scripts/run-probes.js's output). Pure function of that JSON -- does
// not talk to any app or to Plaid, so it can be re-run against a saved
// results file at any time.
//
// Usage: node scripts/generate-report.js <resultsJsonPath> [outputMdPath]

const fs = require('fs');
const path = require('path');
const { bucketForReport } = require('../probes/report');

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function renderItem(r) {
  const reason = r.not_observable_reason ? ` _(${r.not_observable_reason})_` : '';
  return `- **${r.failure_mode}**${reason}: ${oneLine(r.rationale)}`;
}

function renderSection(title, items) {
  const body = items.length ? items.map(renderItem).join('\n') : '_None._';
  return `## ${title}\n\n${body}\n`;
}

function generateReport(results, appName) {
  const buckets = { blocker: [], fast_follow: [], not_observable: [], passing: [] };
  for (const r of results) {
    buckets[bucketForReport(r)].push(r);
  }

  const counts = `${buckets.blocker.length} blocker(s), ${buckets.fast_follow.length} fast-follow(s), ${buckets.not_observable.length} not-observable, ${buckets.passing.length} passing`;

  return [
    `# Go-Live Readiness Report${appName ? ` — ${appName}` : ''}`,
    '',
    `Generated ${new Date().toISOString()}. ${results.length} checks: ${counts}.`,
    '',
    renderSection('Blockers (must fix before go-live)', buckets.blocker),
    '---',
    '',
    renderSection('Fast-Follows (not blocking, worth fixing)', buckets.fast_follow),
    renderSection('Not Observable (unverifiable in this environment)', buckets.not_observable),
  ].join('\n');
}

function main() {
  const [resultsJsonPath, outputMdPath] = process.argv.slice(2);
  if (!resultsJsonPath) {
    console.error('usage: node scripts/generate-report.js <resultsJsonPath> [outputMdPath]');
    process.exit(1);
  }

  const results = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf8'));
  const appName = results[0]?.app;
  const markdown = generateReport(results, appName);

  const outPath = outputMdPath || resultsJsonPath.replace(/-results\.json$/, '-report.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown);

  console.log(markdown);
  console.error(`\nwrote report to ${outPath}`);
}

module.exports = { generateReport };

if (require.main === module) {
  main();
}
