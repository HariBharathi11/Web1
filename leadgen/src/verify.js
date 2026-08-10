/**
 * verify.js — preflight.
 *
 * Every failure this catches is one that would otherwise surface halfway
 * through a run, after the browser is open and the governor has already
 * counted the attempt. Run it before the first daily run and any time
 * something looks wrong; it is read-only and touches nothing.
 *
 * Checks are ordered by how early they would bite.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ok = (m, d) => ({ level: 'ok', m, d });
const warn = (m, d) => ({ level: 'warn', m, d });
const fail = (m, d) => ({ level: 'fail', m, d });

async function checkNode() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 5)) return ok('Node runtime', `v${process.versions.node}`);
  return fail('Node runtime', `v${process.versions.node} — need 22.5+ for the built-in SQLite store`);
}

async function checkBrowser(config) {
  const channel = config.browser?.channel || 'msedge';
  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({ channel, headless: true });
    const v = browser.version();
    await browser.close();
    return ok(`Browser (${channel})`, `launched, engine ${v}`);
  } catch (e) {
    await browser?.close().catch(() => {});
    return fail(`Browser (${channel})`,
      `could not launch. Fix: npx playwright install ${channel}  — or set browser.channel to null in config.json`);
  }
}

function checkConnections(config) {
  const p = path.resolve(ROOT, config.lanes.warm.connectionsCsv);
  if (!fs.existsSync(p)) {
    return fail('Connections export',
      `missing at ${config.lanes.warm.connectionsCsv}\n     LinkedIn → Settings & Privacy → Data Privacy → Get a copy of your data → Connections`);
  }
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).length;
  if (lines < 10) return warn('Connections export', `only ${lines} lines — is the archive complete?`);
  return ok('Connections export', `${lines - 4} connections ready to import`);
}

function checkConfig(config) {
  const problems = [];
  if (/CHANGE_ME/.test(config.product.trialLink)) problems.push('product.trialLink');
  if (/CHANGE_ME/.test(config.sheets.spreadsheetId)) problems.push('sheets.spreadsheetId');
  if (!config.product.signOff) problems.push('product.signOff');
  if (config.outreach.draftOnly !== true) {
    return fail('Config', 'outreach.draftOnly is not true — the engine will refuse to run, by design');
  }
  if (problems.length) return fail('Config', `unset: ${problems.join(', ')}`);
  return ok('Config', `draft-only ON · link ${config.product.trialLink}`);
}

function checkCredentials() {
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(ROOT, 'credentials', 'service-account.json');
  if (!fs.existsSync(p)) {
    return fail('Sheets credentials',
      `no key at credentials/service-account.json — see README § "Google Sheets API auth"`);
  }
  try {
    const key = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!key.client_email) return fail('Sheets credentials', 'key file has no client_email');
    return ok('Sheets credentials', `${key.client_email}\n     ↳ this address must have Editor access on your Sheet`);
  } catch (e) {
    return fail('Sheets credentials', `unreadable: ${e.message}`);
  }
}

async function checkSheetAccess(config) {
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(ROOT, 'credentials', 'service-account.json');
  if (!fs.existsSync(credsPath)) return warn('Sheet access', 'skipped — no credentials yet');

  try {
    const { getClient } = require('./render/sheets');
    const sheets = await getClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.spreadsheetId });
    const tabs = meta.data.sheets.map((s) => s.properties.title);
    return ok('Sheet access', `"${meta.data.properties.title}" — tabs: ${tabs.join(', ') || '(none yet)'}`);
  } catch (e) {
    const msg = e.message || '';
    if (/403|permission/i.test(msg)) {
      const key = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      return fail('Sheet access',
        `403 — share the Sheet with ${key.client_email} as Editor`);
    }
    if (/404/.test(msg)) return fail('Sheet access', 'spreadsheetId not found — check config.sheets.spreadsheetId');
    return fail('Sheet access', msg.split('\n')[0]);
  }
}

function checkPipeline() {
  const DB = require('./db');
  if (!fs.existsSync(DB.DB_PATH)) return warn('Pipeline DB', 'not created yet — the first run makes it');
  const db = DB.open();
  const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  return ok('Pipeline DB', `${n('companies')} companies · ${n('people')} people · ${n('accounts')} scored · ${n('drafts')} drafts`);
}

function checkGovernorState(config) {
  const S = require('./session');
  const g = S.checkGovernor(config);
  const budget = S.remainingProfileBudget(config);
  if (!g.ok) return warn('Cold-lane governor', `${g.reason}\n     (warm + enrich + score + draft + sync are unaffected)`);
  return ok('Cold-lane governor', `clear · ${budget} profile views left today`);
}

// ---------------------------------------------------------------------------

async function verify(config) {
  const results = [];
  results.push(await checkNode());
  results.push(checkConfig(config));
  results.push(checkConnections(config));
  results.push(await checkBrowser(config));
  results.push(checkCredentials());
  results.push(await checkSheetAccess(config));
  results.push(checkPipeline());
  results.push(checkGovernorState(config));

  console.log('\n─── Preflight ───');
  for (const r of results) {
    const icon = r.level === 'ok' ? '✔' : r.level === 'warn' ? '!' : '✖';
    console.log(`  ${icon} ${r.m.padEnd(20)} ${r.d}`);
  }

  const fails = results.filter((r) => r.level === 'fail');
  const warns = results.filter((r) => r.level === 'warn');

  console.log('');
  if (fails.length) {
    console.log(`${fails.length} blocker(s). Fix those before running.`);
  } else if (warns.length) {
    console.log(`Ready. ${warns.length} note(s) above — none block a run.`);
  } else {
    console.log('All clear.');
  }
  console.log('');

  return { results, ok: fails.length === 0 };
}

module.exports = { verify };
