// Generates a single, self-contained report.html from a probe-results JSON
// file (scripts/run-probes.js's output) -- no server, no build step, no
// external resources. All data is pre-rendered into static markup at
// generation time (not fetched or parsed client-side), so the file opens
// directly from disk in any browser.
//
// Unlike scripts/generate-report.js's Markdown report (which only itemizes
// non-passing checks), every check gets a full card here: what was fired,
// the raw observed response, classification, rationale, sandbox_fidelity,
// and not_observable_reason -- all visible, none hidden behind a toggle.
//
// Usage: node scripts/generate-html-report.js <resultsJsonPath> [outputHtmlPath]

const fs = require('fs');
const path = require('path');
const { bucketForReport } = require('../probes/report');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BUCKET_LABELS = {
  blocker: 'Blockers (must fix before go-live)',
  fast_follow: 'Fast-Follows (not blocking, worth fixing)',
  not_observable: 'Not Observable (unverifiable in this environment)',
  passing: 'Passing',
};
const BUCKET_ORDER = ['blocker', 'fast_follow', 'not_observable', 'passing'];

function renderCard(r) {
  const bucket = bucketForReport(r);
  const observedJson = escapeHtml(JSON.stringify(r.observed_response, null, 2));
  return `
    <article class="card ${bucket}">
      <header>
        <span class="badge ${r.classification}">${escapeHtml(r.classification)}</span>
        <span class="badge severity-${r.severity}">${escapeHtml(r.severity)} severity</span>
        <span class="badge ${r.is_blocker ? 'is-blocker' : 'not-blocker'}">is_blocker: ${r.is_blocker}</span>
        <h3>${escapeHtml(r.failure_mode)}</h3>
      </header>

      <dl>
        <dt>What was fired</dt>
        <dd>${escapeHtml(r.what_was_fired)}</dd>

        <dt>Rationale</dt>
        <dd>${escapeHtml(r.rationale)}</dd>

        <dt>sandbox_fidelity</dt>
        <dd><code>${escapeHtml(r.sandbox_fidelity)}</code></dd>

        <dt>not_observable_reason</dt>
        <dd><code>${r.not_observable_reason === null ? 'null' : escapeHtml(r.not_observable_reason)}</code></dd>

        <dt>Observed response</dt>
        <dd><pre>${observedJson}</pre></dd>
      </dl>
    </article>`;
}

function generateHtmlReport(results, appName) {
  const buckets = { blocker: [], fast_follow: [], not_observable: [], passing: [] };
  for (const r of results) buckets[bucketForReport(r)].push(r);

  const counts = `${buckets.blocker.length} blocker(s), ${buckets.fast_follow.length} fast-follow(s), ${buckets.not_observable.length} not-observable, ${buckets.passing.length} passing`;

  const sections = BUCKET_ORDER.map((bucket) => {
    const items = buckets[bucket];
    const cards = items.length ? items.map(renderCard).join('\n') : '<p class="empty">None.</p>';
    return `
    <section id="${bucket}">
      <h2>${escapeHtml(BUCKET_LABELS[bucket])}</h2>
      ${cards}
    </section>`;
  }).join('\n');

  const title = `Go-Live Readiness Report${appName ? ` — ${escapeHtml(appName)}` : ''}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #666666;
    --border: #dddddd;
    --card-bg: #fafafa;
    --code-bg: #f0f0f0;
    --handled: #1a7f37;
    --unhandled: #c9302c;
    --not-observable: #9a6700;
    --blocker: #c9302c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --fg: #e6e6e6;
      --muted: #9a9a9a;
      --border: #33363c;
      --card-bg: #1c1f24;
      --code-bg: #22262c;
      --handled: #3fb950;
      --unhandled: #f85149;
      --not-observable: #d29922;
      --blocker: #f85149;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.5;
    max-width: 900px;
    margin-inline: auto;
  }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  .meta { color: var(--muted); font-size: 0.9rem; margin-bottom: 2rem; }
  h2 { font-size: 1.2rem; margin-top: 2.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.4rem; }
  .empty { color: var(--muted); font-style: italic; }
  .card {
    border: 1px solid var(--border);
    border-left-width: 4px;
    border-radius: 6px;
    background: var(--card-bg);
    padding: 1rem 1.25rem;
    margin: 1rem 0;
  }
  .card.blocker { border-left-color: var(--blocker); }
  .card.fast_follow { border-left-color: var(--not-observable); }
  .card.not_observable { border-left-color: var(--muted); }
  .card.passing { border-left-color: var(--handled); }
  .card header { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
  .card h3 { margin: 0; font-size: 1.05rem; flex-basis: 100%; order: 1; }
  .badge {
    display: inline-block;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .badge.handled { color: var(--handled); border-color: var(--handled); }
  .badge.unhandled { color: var(--unhandled); border-color: var(--unhandled); }
  .badge.not_observable { color: var(--not-observable); border-color: var(--not-observable); }
  .badge.is-blocker { color: var(--blocker); border-color: var(--blocker); }
  dl { margin: 0; }
  dt { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); margin-top: 0.75rem; }
  dt:first-child { margin-top: 0; }
  dd { margin: 0.2rem 0 0; }
  code { background: var(--code-bg); padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.85rem; }
  pre {
    background: var(--code-bg);
    padding: 0.75rem;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 0.8rem;
    margin: 0.3rem 0 0;
  }
</style>
</head>
<body>
  <h1>${title}</h1>
  <p class="meta">Generated ${new Date().toISOString()}. ${results.length} checks: ${counts}.</p>
  ${sections}
</body>
</html>
`;
}

function main() {
  const [resultsJsonPath, outputHtmlPath] = process.argv.slice(2);
  if (!resultsJsonPath) {
    console.error('usage: node scripts/generate-html-report.js <resultsJsonPath> [outputHtmlPath]');
    process.exit(1);
  }

  const results = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf8'));
  const appName = results[0]?.app;
  const html = generateHtmlReport(results, appName);

  const outPath = outputHtmlPath || resultsJsonPath.replace(/-results\.json$/, '-report.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);

  console.error(`wrote report to ${outPath}`);
}

module.exports = { generateHtmlReport };

if (require.main === module) {
  main();
}
