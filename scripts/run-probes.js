// Runs every implemented probe (SPEC.md §4.1-§4.3) against one target app
// and emits the flattened results as a single JSON array to reports/<app>-results.json
// (and to stdout). This is the JSON-emission step; scripts/generate-report.js
// consumes its output to build the Markdown cut-line report.
//
// Usage: node scripts/run-probes.js <appName> <baseUrl> <stateFilePath> <dataDirPath>

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { runItemLoginRequiredProbe } = require('../probes/item-login-required');
const { runWebhookDeliveryFailureProbe } = require('../probes/webhook-delivery-failure');
const { runConsentRevocationProbe } = require('../probes/consent-revocation');

async function main() {
  const [appName, baseUrl, stateFilePath, dataDirPath] = process.argv.slice(2);
  if (!appName || !baseUrl || !stateFilePath || !dataDirPath) {
    console.error('usage: node scripts/run-probes.js <appName> <baseUrl> <stateFilePath> <dataDirPath>');
    process.exit(1);
  }

  const loginRequired = await runItemLoginRequiredProbe({ baseUrl, statePath: stateFilePath });
  const webhookDelivery = await runWebhookDeliveryFailureProbe({ baseUrl, dataDirPath });
  const consentRevocation = await runConsentRevocationProbe({ baseUrl });

  const results = [loginRequired, ...webhookDelivery, ...consentRevocation].map((r) => ({
    app: appName,
    ...r,
  }));

  const outDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${appName}-results.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log(JSON.stringify(results, null, 2));
  console.error(`\nwrote ${results.length} results to ${outPath}`);
}

main().catch((e) => {
  console.error('run-probes failed:', e);
  process.exit(1);
});
