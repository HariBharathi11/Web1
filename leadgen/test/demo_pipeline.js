/**
 * demo_pipeline.js — runs the REAL pipeline against a local fixture "internet".
 *
 * Same code paths as production: warm import → enrichment (browser, real DOM
 * parsing) → Venn scoring → drafting → the exact rows that would go to Sheets.
 * Only the websites are local, because this sandbox has no outbound web.
 */
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright');
const config = require('../config.json');
const DB = require('../src/db'); const H = require('../src/humanize');
const Venn = require('../src/venn'); const Signals = require('../src/signals');
const Sequence = require('../src/sequence'); const R = require('../src/render/sheets');
const { importConnections } = require('../src/lanes/warm');
const { enrichCompany } = require('../src/enrich/company');
const { buildDraft } = require('../src/messages');

const WEB = path.resolve(__dirname, 'fixtures/web');
// company key → fixture directory (stands in for domain resolution, which
// needs the real internet; guessDomains is covered by its own test)
// companyKey() output → fixture directory. Each gets its OWN origin, because
// probeCareers correctly derives paths from URL.origin like a real domain.
const SITES = {
  'zeta-staffing': 'zeta', 'gulf-talent-partners': 'gulftalent',
  'mega-industries': 'megaind', 'delta-manufacturing': 'delta',
  'quiet': 'quiet', 'apex-recruitment-partners': 'apex',
};

function serveSite(dir) {
  return http.createServer((req, res) => {
    const seg = req.url.split('?')[0].split('/')[1] || '';
    let file = 'index.html';
    for (const cand of ['careers', 'jobs']) {
      if (seg.startsWith(cand) && fs.existsSync(path.join(dir, cand + '.html'))) file = cand + '.html';
    }
    if (seg && file === 'index.html' && seg !== '') { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fs.readFileSync(path.join(dir, file)));
  });
}

(async () => {
  const servers = {};
  for (const dir of new Set(Object.values(SITES))) {
    const srv = serveSite(path.join(WEB, dir));
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    servers[dir] = `http://127.0.0.1:${srv.address().port}`;
    servers['_' + dir] = srv;
  }

  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB.DB_PATH + s, { force: true });
  const db = DB.open();

  console.log('\n━━━ 1. WARM IMPORT (no browser, no risk) ━━━');
  const w = importConnections(db, config, 'test/fixtures/Connections-demo.csv');
  console.log(`   ${w.rows} rows → ${w.people} people at ${w.companies} companies`);
  console.log(`   ICP: ${w.icp} (tier1 ${w.tier1}, tier2 ${w.tier2}) · segments ${JSON.stringify(w.bySegment)}`);
  console.log(`   ${Signals.deriveConnectionRecency(db, config)} connected within 90 days`);

  // point each company at its fixture site
  for (const [key, dir] of Object.entries(SITES)) {
    const row = db.prepare('SELECT id,name FROM companies WHERE key=?').get(key);
    if (row) DB.upsertCompany(db, { name: row.name, domain: servers[dir] });
    else console.log(`   (no company row for key "${key}")`);
  }

  console.log('\n━━━ 2. ENRICHMENT (real browser, real DOM parsing) ━━━');
  const browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const persona = H.newPersona();
  const t0 = Date.now();
  for (const c of DB.companiesNeedingEnrichment(db, { limit: 20 })) {
    const r = await enrichCompany(db, page, c, config, persona);
    console.log(`   ${r.changed ? '✔' : '·'} ${c.name.slice(0,32).padEnd(32)} ${r.note}`);
  }
  console.log(`   (${Math.round((Date.now()-t0)/1000)}s for ${Object.keys(SITES).length} companies)`);
  await browser.close();

  console.log('\n━━━ 3. VENN SCORING ━━━');
  for (const co of DB.allCompanies(db)) {
    const people = DB.peopleForCompany(db, co.id);
    const sig = Signals.signalsForCompany(db, co.id);
    const s = Venn.scoreAccount(co, people, sig, config, Signals.personSignalMap(db, co.id));
    DB.saveAccount(db, co.id, s);
    if (s.blockers.length) DB.upsertCompany(db, { name: co.name, blockers: s.blockers });
  }
  console.log('   pri  band  company                    region  fit  acc  tim  openings');
  for (const a of DB.topAccounts(db, 20)) {
    console.log(`   ${String(a.priority).padStart(3)}   ${a.band}    ${(a.name||'').slice(0,26).padEnd(26)} ${(a.region||'-').padEnd(6)} ${String(a.fit).padStart(3)}  ${String(a.access).padStart(3)}  ${String(a.timing).padStart(3)}  ${a.live_openings}`);
  }

  console.log('\n━━━ 4. DRAFTS ━━━');
  const accts = db.prepare("SELECT a.*, c.* FROM accounts a JOIN companies c ON c.id=a.company_id WHERE a.band IN ('A','B') ORDER BY a.priority DESC").all();
  for (const row of accts) {
    const company = { ...row, id: row.company_id, name: row.name };
    const people = DB.peopleForCompany(db, company.id);
    const target = people.find(p=>p.seniority_tier==='tier1') || people.find(p=>p.seniority_tier==='tier2');
    if (!target) continue;
    const d = buildDraft({ company, person: target, signals: Signals.signalsForCompany(db, company.id) }, config);
    DB.saveDraft(db, target.id, { angle: d.angle, body: d.body, status: d.ok?'DRAFT':'WITHHELD', note: d.reason });
    if (d.ok) Sequence.scheduleSequence(db, target.id);
    console.log(`\n   ── ${company.name} → ${target.name} [${d.ok?'DRAFT':'WITHHELD'}] ${d.angle||''}`);
    console.log(d.ok ? d.body.split('\n').map(l=>'      '+l).join('\n') : '      ' + d.reason);
  }

  console.log('\n━━━ 5. WHAT WOULD GO TO GOOGLE SHEETS ━━━');
  for (const [tab, fn] of [['Accounts',R.accountRows],['Companies',R.companyRows],['People',R.peopleRows],['Message Drafts',R.draftRows]]) {
    console.log(`   ${tab.padEnd(15)} ${String(fn(db).length).padStart(3)} rows × ${R.HEADERS[tab.toLowerCase().replace('message ','')].length} cols`);
  }
  const acts = R.actionRows(db, config);
  console.log(`   Daily Actions   ${String(acts.length).padStart(3)} rows × ${R.HEADERS.actions.length} cols`);
  console.log('\n   Daily Actions preview:');
  for (const a of acts.slice(0,8)) console.log(`     ${a[0]} | ${a[1].padEnd(7)} | ${a[3].padEnd(14)} | ${(a[5]||'').slice(0,24).padEnd(24)} | pri ${a[6]}`);

  console.log('\n   Companies tab — enrichment captured:');
  for (const c of R.companyRows(db)) console.log(`     ${c[0].slice(0,26).padEnd(26)} ${(c[2]||'-').padEnd(5)} ${(c[3]||'').padEnd(10)} open=${String(c[5]).padStart(2)} ats=${(c[6]||'-').padEnd(8)} socials=${[c[8],c[9],c[10],c[11],c[12],c[13]].filter(Boolean).length}`);

  for (const k of Object.keys(servers)) if (k.startsWith('_')) servers[k].close();
})();
