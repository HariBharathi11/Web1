/**
 * warm.test.js — the warm lane and the company-first store.
 *
 * Company dedupe is load-bearing: if "Infosys Ltd" and "Infosys" stay separate
 * accounts, the Access axis never sees that there are two routes in, and the
 * whole account-based model degrades back into a flat list of people.
 */

const assert = require('node:assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const config = require('../config.json');
const DB = require('../src/db');
const { importConnections, parseCsv, findHeader } = require('../src/lanes/warm');
const Sequence = require('../src/sequence');

const FIXTURE = path.resolve(__dirname, 'fixtures/Connections.csv');

/** Each test gets its own database file. */
function freshDb(name) {
  const p = path.join(DB.STATE_DIR, `test-${name}.db`);
  fs.mkdirSync(DB.STATE_DIR, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(p);
  db.exec(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'db.js'), 'utf8')
    .match(/const SCHEMA = `([\s\S]*?)`;/)[1]);
  return db;
}

// ---------------------------------------------------------------------------

test('CSV parser survives quoted commas and ampersands', () => {
  const rows = parseCsv('a,b\n"Smith, Jones & Co",x\n"He said ""hi""",y\n');
  assert.equal(rows[1][0], 'Smith, Jones & Co');
  assert.equal(rows[2][0], 'He said "hi"');
});

test('header is found past the export preamble', () => {
  const rows = parseCsv(fs.readFileSync(FIXTURE, 'utf8'));
  const idx = findHeader(rows);
  assert.ok(idx > 0, 'LinkedIn puts Notes: lines above the header');
  assert.ok(rows[idx].map((c) => c.toLowerCase()).includes('first name'));
});

test('company name variants collapse to one account', () => {
  const db = freshDb('dedupe');
  importConnections(db, config, FIXTURE);

  const names = db.prepare('SELECT name FROM companies').all().map((r) => r.name);
  const keys = db.prepare('SELECT key FROM companies').all().map((r) => r.key);

  assert.equal(new Set(keys).size, keys.length, 'keys must be unique');

  // "Infosys Ltd" + "Infosys" → one; "Acme Industries Limited" + "ACME INDUSTRIES" → one;
  // "Zeta Staffing Solutions Pvt Ltd" + "Zeta Staffing Solutions" → one.
  assert.equal(names.length, 5, `expected 5 deduped companies, got ${names.length}: ${names}`);

  const infosys = db.prepare("SELECT id FROM companies WHERE key = 'infosys'").get();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM people WHERE company_id = ?').get(infosys.id).n, 2,
    'both Infosys contacts must attach to the same account');
});

test('everyone imported from the connections export is first-degree', () => {
  const db = freshDb('degree');
  importConnections(db, config, FIXTURE);
  const notFirst = db.prepare('SELECT COUNT(*) n FROM people WHERE degree != 1').get().n;
  assert.equal(notFirst, 0);
});

test('rows with no company are skipped, not turned into phantom accounts', () => {
  const db = freshDb('nocompany');
  const stats = importConnections(db, config, FIXTURE);
  assert.equal(stats.skippedNoCompany, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM companies WHERE name = ''").get().n, 0);
});

test('re-importing the same export does not duplicate anything', () => {
  const db = freshDb('idempotent');
  const first = importConnections(db, config, FIXTURE);
  const before = db.prepare('SELECT COUNT(*) n FROM people').get().n;
  importConnections(db, config, FIXTURE);
  const after = db.prepare('SELECT COUNT(*) n FROM people').get().n;
  assert.equal(after, before, 'import must be idempotent — it runs every day');
  assert.equal(before, first.people);
});

test('a missing export explains how to produce one', () => {
  const db = freshDb('missing');
  const r = importConnections(db, config, 'input/does-not-exist.csv');
  assert.equal(r.ok, false);
  assert.match(r.howTo, /Get a copy of your data/);
});

// ---------------------------------------------------------------------------

test('touch sequence', async (t) => {
  const db = freshDb('sequence');
  const cid = DB.upsertCompany(db, { name: 'Zeta Staffing' });
  const pid = DB.upsertPerson(db, { linkedin_url: 'https://x/in/a', company_id: cid, name: 'A', degree: 1 });

  await t.test('schedules view → engage → message', () => {
    Sequence.scheduleSequence(db, pid);
    const steps = db.prepare('SELECT step, due_on FROM touches WHERE person_id = ? ORDER BY due_on').all(pid);
    assert.deepEqual(steps.map((s) => s.step), ['view', 'engage', 'message']);
    assert.ok(steps[0].due_on <= steps[2].due_on, 'message comes last');
  });

  await t.test('is idempotent — re-running never resets a sequence in flight', () => {
    Sequence.scheduleSequence(db, pid);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM touches WHERE person_id = ?').get(pid).n, 3);
  });

  await t.test('never lands a step on a weekend', () => {
    for (const t of db.prepare('SELECT due_on FROM touches').all()) {
      const day = new Date(t.due_on + 'T00:00:00Z').getUTCDay();
      assert.ok(day !== 0 && day !== 6, `${t.due_on} falls on a weekend`);
    }
  });

  await t.test('a withheld draft is never queued for sending', () => {
    DB.saveDraft(db, pid, { body: '', status: 'WITHHELD', note: 'unverifiable' });
    const { actions } = Sequence.dueToday(db, config, '2099-01-01');
    assert.equal(actions.filter((a) => a.step === 'message').length, 0,
      'the withhold guard must not be bypassed by the scheduler');
  });

  await t.test('respects the daily send ceiling', () => {
    const capped = { ...config, outreach: { ...config.outreach, dailySendCeiling: 2 } };
    for (let i = 0; i < 5; i++) {
      const p = DB.upsertPerson(db, { linkedin_url: `https://x/in/p${i}`, company_id: cid, name: `P${i}`, degree: 1 });
      DB.saveDraft(db, p, { body: 'hi', status: 'DRAFT' });
      Sequence.scheduleSequence(db, p);
    }
    const { messagesQueued } = Sequence.dueToday(db, capped, '2099-01-01');
    assert.ok(messagesQueued <= 2, `ceiling ignored: ${messagesQueued} queued`);
  });
});

// ---------------------------------------------------------------------------

test('store merges rather than overwrites', async (t) => {
  const db = freshDb('merge');

  await t.test('a later blank never wipes an earlier value', () => {
    const id = DB.upsertCompany(db, { name: 'Delta Mfg', domain: 'https://delta.com', live_openings: 12 });
    DB.upsertCompany(db, { name: 'Delta Mfg' }); // e.g. a cold-lane sighting with no enrichment
    const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    assert.equal(row.domain, 'https://delta.com');
    assert.equal(row.live_openings, 12);
  });

  await t.test('a closer connection wins, a more distant one does not regress it', () => {
    const cid = DB.upsertCompany(db, { name: 'Delta Mfg' });
    const pid = DB.upsertPerson(db, { linkedin_url: 'https://x/in/z', company_id: cid, name: 'Z', degree: 3 });
    DB.upsertPerson(db, { linkedin_url: 'https://x/in/z', company_id: cid, name: 'Z', degree: 1 });
    assert.equal(db.prepare('SELECT degree FROM people WHERE id = ?').get(pid).degree, 1);
    DB.upsertPerson(db, { linkedin_url: 'https://x/in/z', company_id: cid, name: 'Z', degree: 3 });
    assert.equal(db.prepare('SELECT degree FROM people WHERE id = ?').get(pid).degree, 1,
      'a cold sighting must not downgrade a known connection');
  });
});
