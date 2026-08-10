/**
 * venn.test.js — the design's core claims, asserted.
 *
 * The Venn is the whole argument of this system: outreach capacity only goes
 * where Fit, Access and Timing overlap. If the geometric mean ever gets
 * "fixed" into an addition, these tests are what catch it.
 */

const assert = require('node:assert');
const test = require('node:test');
const path = require('path');
const fs = require('fs');

const config = require('../config.json');
const Venn = require('../src/venn');
const { classifySeniority } = require('../src/score');
const { buildDraft, roleVolumePhrase, firstName } = require('../src/messages');

const fresh = () => new Date().toISOString();

const co = (over = {}) => ({
  name: 'Test Co', segment: 'midmarket', region: 'IN',
  live_openings: 0, ats: null, openings_checked_at: fresh(), ...over,
});
const person = (over = {}) => ({ id: 1, name: 'Test Person', title: 'CHRO', seniority_tier: 'tier1', degree: 1, ...over });

// ---------------------------------------------------------------------------

test('a zero on ANY axis kills the account', async (t) => {
  await t.test('no access → dead, however good the fit', () => {
    const s = Venn.scoreAccount(
      co({ segment: 'staffing', live_openings: 80, ats: 'greenhouse' }), [], [], config
    );
    assert.equal(s.access, 0);
    assert.ok(s.priority < 10, `expected near-zero, got ${s.priority}`);
    assert.equal(s.band, 'C');
  });

  await t.test('no timing → dead, however warm the contact', () => {
    const s = Venn.scoreAccount(co({ live_openings: 0 }), [person()], [], config);
    assert.equal(s.timing, 0);
    assert.ok(s.priority < 10, `expected near-zero, got ${s.priority}`);
    assert.equal(s.band, 'C');
  });

  await t.test('the next action names the weakest axis', () => {
    const s = Venn.scoreAccount(co({ live_openings: 0 }), [person()], [], config);
    assert.match(s.next_action, /timing/);
  });
});

test('a warm first-degree contact at a hiring staffing agency reaches Band A', () => {
  const s = Venn.scoreAccount(
    co({ name: 'Zeta Staffing Solutions', segment: 'staffing', live_openings: 25, ats: 'keka' }),
    [person({ title: 'Managing Director' }), person({ id: 2, title: 'TA Lead', seniority_tier: 'tier2' })],
    [], config
  );
  assert.equal(s.band, 'A', `expected Band A, got ${s.band} (${s.priority})`);
});

test('access is strictly better when the contact is closer', () => {
  const build = (degree) => Venn.scoreAccount(
    co({ segment: 'staffing', live_openings: 25 }), [person({ degree })], [], config
  );
  const first = build(1), second = build(2), cold = build(3);
  assert.ok(first.priority > second.priority, 'first-degree must beat second');
  assert.ok(second.priority > cold.priority, 'second-degree must beat cold');
});

test('region multipliers order as configured', () => {
  const at = (region) => Venn.scoreAccount(
    co({ segment: 'staffing', region, live_openings: 25 }), [person()], [], config
  ).fit;
  assert.ok(at('US') >= at('GULF'), 'US should not score below Gulf');
  assert.ok(at('GULF') > at('IN'), 'Gulf multiplier should beat India');
  assert.ok(at('IN') > at('OTHER'), 'India should beat unclassified');
});

test('US/EU enterprise is downgraded for the SOC 2 gate, with the blocker visible', () => {
  const enterprise = Venn.scoreAccount(
    co({ name: 'Mega Industries', segment: 'enterprise', region: 'US', live_openings: 60, ats: 'workday' }),
    [person()], [], config
  );
  const staffing = Venn.scoreAccount(
    co({ name: 'Mega Staffing', segment: 'staffing', region: 'US', live_openings: 60, ats: 'greenhouse' }),
    [person()], [], config
  );

  assert.ok(enterprise.blockers.some((b) => /SOC 2/.test(b)), 'blocker must be recorded, not hidden');
  assert.ok(staffing.priority > enterprise.priority,
    'US staffing must outrank US enterprise — the guide says the SOC 2 gate is a real non-fit');
});

test('stale hiring evidence is discounted, not trusted', () => {
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  const fresh_ = Venn.scoreAccount(co({ live_openings: 30 }), [person()], [], config);
  const stale = Venn.scoreAccount(co({ live_openings: 30, openings_checked_at: old }), [person()], [], config);
  assert.ok(stale.timing < fresh_.timing, 'two-month-old evidence must score lower than today’s');
});

test('segment comes from the company name, never from employee titles', () => {
  // A "Recruitment Manager" works at every large company. If titles leaked into
  // segment detection, Infosys would collect the +40 staffing bonus.
  assert.equal(Venn.segmentOf({ name: 'Infosys' }), 'midmarket');
  assert.equal(Venn.segmentOf({ name: 'Zeta Staffing Solutions' }), 'staffing');
  assert.equal(Venn.segmentOf({ name: 'Apex Recruitment Partners' }), 'staffing');
  assert.equal(Venn.segmentOf({ name: 'Mega Industries' }), 'enterprise');
});

// ---------------------------------------------------------------------------

test('seniority classification', () => {
  assert.equal(classifySeniority('CHRO', config), 'tier1');
  assert.equal(classifySeniority('VP Human Resources', config), 'tier1');
  assert.equal(classifySeniority('Head of People', config), 'tier1');
  // At a 20-person agency the founder IS the buyer.
  assert.equal(classifySeniority('Managing Director', config), 'tier1');
  assert.equal(classifySeniority('Talent Acquisition Lead', config), 'tier2');
  assert.equal(classifySeniority('HR Manager', config), 'tier2');
  assert.equal(classifySeniority('Software Engineer', config), 'other');
});

// ---------------------------------------------------------------------------

test('drafts are withheld rather than guessed', async (t) => {
  await t.test('no verified openings → no volume claim', () => {
    const d = buildDraft({
      company: co({ segment: 'midmarket', live_openings: 0 }),
      person: person({ name: 'Sunil Rao', seniority_tier: 'tier2' }),
      signals: [],
    }, config);
    // Falls back to a non-numeric angle rather than inventing a number.
    if (d.ok) assert.doesNotMatch(d.body, /\d+\s*(–|-)\s*\d+\s+roles/, 'must not state a volume it cannot verify');
  });

  await t.test('monthly range stays below the live count', () => {
    // A careers page accumulates ~2 months of postings; claiming the live count
    // as a monthly rate is an overclaim the prospect will spot immediately.
    for (const openings of [6, 12, 30, 52, 100]) {
      const [low, high] = roleVolumePhrase(openings).split('–').map(Number);
      assert.ok(high < openings, `${openings} openings → claimed up to ${high}/month, must be lower`);
      assert.ok(low >= 3 && low <= high);
    }
  });

  await t.test('too few openings to make any claim', () => {
    assert.equal(roleVolumePhrase(5), null);
    assert.equal(roleVolumePhrase(0), null);
  });
});

test('draft body never doubles the name or the call to action', () => {
  const d = buildDraft({
    company: co({ name: 'Delta Manufacturing Ltd', segment: 'midmarket', live_openings: 14 }),
    person: person({ name: 'Dr Meera Iyer' }),
    signals: [{ kind: 'post_engagement' }],
  }, config);

  assert.ok(d.ok);
  assert.equal(d.body.match(/Meera/g).length, 1, 'first name must appear exactly once');
  assert.equal(d.body.match(/free on/gi).length, 1, 'the free-trial CTA must appear exactly once');
  assert.match(d.body, /HAB Business Solutions$/, 'must carry the sign-off');
});

test('honorifics are stripped from the greeting', () => {
  assert.equal(firstName('Dr Priya Menon'), 'Priya');
  assert.equal(firstName('Rahul Sharma'), 'Rahul');
});

test('the draft-only guard aborts the run', () => {
  const unsafe = JSON.parse(JSON.stringify(config));
  unsafe.outreach.draftOnly = false;
  assert.throws(() => buildDraft({ company: co(), person: person(), signals: [] }, unsafe),
    /REFUSING TO RUN/);
});

test('no send path exists anywhere in src/', () => {
  // The strongest guarantee is structural: grep the source for a send call.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

  const offenders = [];
  for (const file of walk(path.resolve(__dirname, '..', 'src'))) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(file, 'utf8');
    // Clicking a LinkedIn Send button, or submitting a message form.
    if (/click\([^)]*(['"`]).*\b(Send|send-message|msg-form)\b/i.test(src)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `send path found in: ${offenders.join(', ')}`);
});
