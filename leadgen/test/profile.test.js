/**
 * profile.test.js — the conversion rubric and the engagement lift.
 *
 * The engagement test is the important one. venn.js and playbook.js have both
 * consumed a `post_engagement` signal since they were written, but nothing
 * produced it — so the code path was live and unreachable. The test asserts the
 * lift is real, which is the only way to know the lane is actually wired to the
 * scorer rather than just writing rows nobody reads.
 */

const assert = require('node:assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const config = require('../config.json');
const Audit = require('../src/profile/audit');
const Venn = require('../src/venn');
const DB = require('../src/db');
const Signals = require('../src/signals');
const { buildDraft } = require('../src/messages');
const { companyFromHeadline } = require('../src/lanes/engagement');

// ---------------------------------------------------------------------------
// Rubric
// ---------------------------------------------------------------------------

const weakProfile = {
  name: 'Hari', headline: 'Founder', hasPhoto: true, hasBanner: false, cta: null,
  followers: 300, aboutSectionPresent: false, about: null,
  featuredSectionPresent: false, featuredCount: 0, featuredItems: [],
  experience: ['Founder'], skillsCount: 2, recommendationsCount: 0,
};

const strongProfile = {
  name: 'Hari',
  headline: 'Helping staffing agencies shortlist in 24 hours instead of 4 days | Founder, HAB Business Solutions | MinMaxHR',
  hasPhoto: true, hasBanner: true,
  cta: { label: 'Visit my website', href: 'https://minmaxhr.com/contact' },
  followers: 2000, aboutSectionPresent: true,
  about: 'Your recruiters are reading resume piles instead of hiring. MinMaxHR ranks and explains every applicant in 24 hours instead of 4 days. Free on one live role: minmaxhr.com/contact. '.repeat(3),
  featuredSectionPresent: true, featuredCount: 3,
  featuredItems: ['MinMaxHR Buyer\'s Guide PDF', 'Free ranked shortlist in 24 hours', 'Sample ranked report'],
  experience: ['Founder at HAB'], skillsCount: 12, recommendationsCount: 4,
};

const noActivity = { count: 0, posts: [] };
const goodActivity = {
  count: 10,
  posts: Array.from({ length: 10 }, (_, i) => ({
    ageValue: i + 1, ageUnit: 'd', reactions: 30, comments: 4, snippet: 'post',
  })),
};

test('a bare profile scores low and names the right gaps', () => {
  const r = Audit.audit(weakProfile, noActivity, config);
  assert.ok(r.score < 35, `expected a low score, got ${r.score}`);

  const bad = r.findings.filter((f) => f.level === 'bad').map((f) => f.element);
  for (const el of ['Headline', 'About', 'Featured', 'Recent activity', 'Banner', 'CTA button']) {
    assert.ok(bad.includes(el), `${el} should be flagged as bad on a bare profile`);
  }
});

test('an optimised profile scores high', () => {
  const r = Audit.audit(strongProfile, goodActivity, config);
  assert.ok(r.score >= 85, `expected a high score, got ${r.score}`);
});

test('priorities are ordered by recoverable points, not by rubric order', () => {
  const r = Audit.audit(weakProfile, noActivity, config);
  const gaps = r.priorities.map((f) => f.weight - f.earned);
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(gaps[i - 1] >= gaps[i], 'priorities must be sorted by points available');
  }
  // Featured (20) and Headline (20) are the biggest single wins on a bare profile.
  assert.ok(['Featured', 'Headline'].includes(r.priorities[0].element),
    `expected Featured or Headline first, got ${r.priorities[0].element}`);
});

test('a job-title-only headline is called out specifically', () => {
  const r = Audit.audit({ ...weakProfile, headline: 'Founder & CEO' }, noActivity, config);
  const h = r.findings.find((f) => f.element === 'Headline');
  assert.equal(h.level, 'bad');
  assert.match(h.issue, /job title only/i);
});

test('suggested copy never outruns the buyer\'s guide', () => {
  const copy = Audit.suggestHeadlines(config).join(' ') + ' ' + Audit.suggestAbout(config);

  // Claims that ARE in the guide.
  assert.match(copy, /24 hours/);
  assert.match(copy, /minmaxhr\.com/i);

  // Claims that are NOT, and must never appear.
  assert.doesNotMatch(copy, /SOC ?2 certified/i, 'SOC 2 is explicitly not certified yet');
  assert.doesNotMatch(copy, /\bguarantee/i);
  assert.doesNotMatch(copy, /best in (the )?world|#1|number one/i);
  assert.doesNotMatch(copy, /\bATS\b(?!,| |\.)/, 'must not imply it is an ATS');
});

test('suggested About leads with the reader, not the founder', () => {
  const about = Audit.suggestAbout(config);
  const firstLine = about.split('\n')[0];
  assert.doesNotMatch(firstLine, /^(I |My |We are a )/, 'the first line is the only one reliably read — it must be about them');
  assert.match(firstLine, /hiring teams|triage|applications/i);
});

// ---------------------------------------------------------------------------
// Engagement lift — the reason Lane B exists
// ---------------------------------------------------------------------------

test('company is parsed out of an engager headline', () => {
  assert.equal(companyFromHeadline('CHRO at Acme Industries'), 'Acme Industries');
  assert.equal(companyFromHeadline('Talent Lead at Zeta Staffing | Hiring'), 'Zeta Staffing');
  assert.equal(companyFromHeadline('Founder'), '');
});

test('a post_engagement signal measurably lifts the account', () => {
  const company = {
    name: 'Zeta Staffing', segment: 'staffing', region: 'IN',
    live_openings: 12, ats: 'keka', openings_checked_at: new Date().toISOString(),
  };
  const person = { id: 7, name: 'Rahul', title: 'Managing Director', seniority_tier: 'tier1', degree: 2 };

  const before = Venn.scoreAccount(company, [person], [], config, {});
  const after = Venn.scoreAccount(
    company, [person],
    [{ kind: 'post_engagement' }],           // company-level timing evidence
    config,
    { 7: { engaged: true } }                 // person-level access evidence
  );

  assert.ok(after.access > before.access, `Access must rise: ${before.access} → ${after.access}`);
  assert.ok(after.timing > before.timing, `Timing must rise: ${before.timing} → ${after.timing}`);
  assert.ok(after.priority > before.priority, `Priority must rise: ${before.priority} → ${after.priority}`);
});

test('an engaged lead gets the engaged angle, not a generic one', () => {
  const company = { name: 'Zeta Staffing', segment: 'staffing', live_openings: 40 };
  const person = { id: 7, name: 'Rahul Sharma', degree: 2 };

  const cold = buildDraft({ company, person, signals: [] }, config);
  const engaged = buildDraft({ company, person, signals: [{ kind: 'post_engagement' }] }, config);

  assert.match(engaged.angle, /engaged/, `expected the engaged angle, got ${engaged.angle}`);
  assert.notEqual(cold.angle, engaged.angle, 'engagement must change the pitch');
  assert.match(engaged.body, /engaging with the post/i);
});

test('the engaged angle exists for every segment', () => {
  const { MATRIX } = require('../src/playbook');
  for (const segment of Object.keys(MATRIX)) {
    assert.ok(MATRIX[segment].engaged, `${segment} is missing an engaged angle`);
  }
});

// ---------------------------------------------------------------------------
// Network analysis
// ---------------------------------------------------------------------------

test('network analysis reports composition and finds gaps', () => {
  const p = path.join(DB.STATE_DIR, 'test-network.db');
  fs.mkdirSync(DB.STATE_DIR, { recursive: true });
  for (const s of ['', '-wal', '-shm']) fs.rmSync(p + s, { force: true });

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(p);
  db.exec(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'db.js'), 'utf8')
    .match(/const SCHEMA = `([\s\S]*?)`;/)[1]);

  const { importConnections } = require('../src/lanes/warm');
  importConnections(db, config, 'test/fixtures/Connections-demo.csv');

  const N = require('../src/lanes/network');
  const a = N.analyse(db, config);

  assert.equal(a.total, 10);
  assert.ok(a.bySeniority.tier1 > 0 && a.bySeniority.tier2 > 0);
  assert.ok(a.bySegment.staffing > 0, 'fixture has staffing agencies');
  assert.equal(a.multiRouteCompanies, 2, 'Zeta and Delta each have 2+ ICP contacts');

  const gaps = N.findGaps(a, config);
  assert.ok(gaps.some((g) => /ICP contacts vs/.test(g.issue)),
    'a 10-person network cannot support the target — that gap must be reported');
  for (const g of gaps) assert.ok(g.action, 'every gap must name a next action');
});
