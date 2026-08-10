// End-to-end: serve a fixture company site, enrich against it, re-score.
const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright');
const DB = require('../src/db'); const H = require('../src/humanize');
const Venn = require('../src/venn'); const Signals = require('../src/signals');
const { enrichCompany } = require('../src/enrich/company');
const config = require('../config.json');

const dir = path.resolve(__dirname, 'fixtures/site');
const server = http.createServer((req, res) => {
  const f = req.url.startsWith('/careers') ? 'careers.html' : 'index.html';
  res.writeHead(200, {'content-type':'text/html'}); res.end(fs.readFileSync(path.join(dir, f)));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = DB.open();

  const id = DB.upsertCompany(db, { name: 'Delta Manufacturing Ltd', domain: base });
  DB.upsertPerson(db, { linkedin_url: 'https://linkedin.com/in/sunil-x', company_id: id,
    name: 'Sunil Rao', title: 'HR Manager', seniority_tier: 'tier2', degree: 1, source_lane: 'warm' });

  const browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await (await browser.newContext({ viewport:{width:1280,height:800} })).newPage();

  const co = db.prepare('SELECT * FROM companies WHERE id=?').get(id);
  const r = await enrichCompany(db, page, co, config, H.newPersona());
  console.log('enrich →', r.note);

  const after = db.prepare('SELECT * FROM companies WHERE id=?').get(id);
  console.log('  region:', after.region, '| openings:', after.live_openings, '| ats:', after.ats);
  console.log('  socials:', Object.keys(JSON.parse(after.socials||'{}')).join(', '));

  const people = DB.peopleForCompany(db, id);
  const sig = Signals.signalsForCompany(db, id);
  console.log('  signals:', sig.map(s=>s.kind).join(', '));
  const s = Venn.scoreAccount(after, people, sig, config);
  console.log(`\nVENN → [${s.band}] priority ${s.priority} (fit ${s.fit} · access ${s.access} · timing ${s.timing})`);
  console.log('  next:', s.next_action);

  await browser.close(); server.close();
})();
