/**
 * careers.test.js — careers-page discovery.
 *
 * Regression guard for a bug that silently cost Band A accounts: an earlier
 * probeCareers shuffled nine candidate paths and tried only five, so a company
 * publishing at /jobs was missed ~44% of the time and scored zero on Timing.
 * A false zero is indistinguishable from a genuinely quiet company, so it never
 * surfaced as an error — it just quietly dropped real prospects.
 */

const assert = require('node:assert');
const test = require('node:test');
const http = require('http');
const { chromium } = require('playwright');

const config = require('../config.json');
const { probeCareers, countOpenings } = require('../src/careers');

const EXEC = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function roles(n, prefix = 'Engineer') {
  return Array.from({ length: n }, (_, i) => `<li><a href="/x/${i}">${prefix} ${i}</a></li>`).join('');
}

/** Serves one site whose careers page lives at `pathName`. */
function siteServer({ pathName, count, homeLinkText, ats = '' }) {
  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const html = (body) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    };
    if (url === '/') {
      const link = homeLinkText ? `<a href="${pathName}">${homeLinkText}</a>` : '';
      return html(`<!doctype html><title>Home</title><body><h1>Co</h1>${link}</body>`);
    }
    if (url === pathName) {
      return html(`<!doctype html><title>Careers</title><body><ul>${roles(count)}</ul><script>${ats}</script></body>`);
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('nope');
  });
}

// One browser for the whole file — launching per case costs seconds each.
let browser, page;
test.before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: EXEC });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
});
test.after(async () => { await browser?.close(); });

async function withSite(opts, fn) {
  const srv = siteServer(opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    return await fn(page, base);
  } finally {
    srv.close();
  }
}

test('finds the careers page at every supported path, every time', async () => {
  // Run each path repeatedly — the old sampling bug was probabilistic, so a
  // single pass could pass by luck.
  for (const p of ['/careers', '/jobs', '/openings', '/current-openings', '/work-with-us']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = await withSite({ pathName: p, count: 12 }, (page, base) =>
        probeCareers(page, base, config));
      assert.ok(found, `missed careers page at ${p} (attempt ${attempt + 1})`);
      assert.equal(found.openings, 12, `wrong count at ${p}`);
    }
  }
});

test('follows the site\'s own careers link, including off-origin ATS boards', async () => {
  const found = await withSite(
    { pathName: '/we-are-hiring', count: 7, homeLinkText: 'Careers' },
    (page, base) => probeCareers(page, base, config)
  );
  assert.ok(found, 'should follow a labelled link to a non-standard path');
  assert.equal(found.openings, 7);
  assert.match(found.careersUrl, /we-are-hiring/);
});

test('a company with no openings returns null rather than a false count', async () => {
  const found = await withSite({ pathName: '/careers', count: 0 }, (page, base) =>
    probeCareers(page, base, config));
  assert.equal(found, null, 'no openings must not be reported as a page with openings');
});

test('counts an ATS embed as a hiring-infrastructure signal', async () => {
  const found = await withSite(
    { pathName: '/careers', count: 0, ats: '/* powered by greenhouse */' },
    (page, base) => probeCareers(page, base, config)
  );
  assert.ok(found, 'an ATS embed alone is still a signal worth recording');
  assert.equal(found.atsDetected, true);
});
