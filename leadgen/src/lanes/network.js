/**
 * lanes/network.js — what is actually IN your network.
 *
 * No browser, no LinkedIn traffic, no risk. Pure analysis of the connections
 * export you already downloaded, and the fastest useful answer available.
 *
 * The revenue map works out how many sends the target needs. This answers the
 * question it cannot: **do you have enough of the right people to send to, and
 * where is the network thin?** A network of 2,000 that is mostly peers and
 * engineers cannot support a staffing-agency GTM no matter how good the
 * messaging is, and it is far better to learn that on day one than in week six.
 */

const { classifySeniority } = require('../score');
const { segmentOf } = require('../venn');
const { companyKey } = require('../db');

const DAY = 86400000;

function pct(n, total) {
  return total ? Math.round((n / total) * 100) : 0;
}

/**
 * Builds the composition report from rows already imported into the DB, so it
 * reflects exactly what the pipeline will actually work with — not a separate
 * parse that could drift from it.
 */
function analyse(db, config) {
  const people = db.prepare(`
    SELECT p.*, c.name AS company_name, c.segment, c.region, c.live_openings
    FROM people p LEFT JOIN companies c ON c.id = p.company_id
    WHERE p.degree = 1
  `).all();

  const total = people.length;
  const out = {
    total,
    bySeniority: {}, bySegment: {}, byRegion: {}, byRecency: {},
    icp: 0, reachableIcpCompanies: 0, topCompanies: [], gaps: [],
  };

  if (!total) return out;

  const companyContacts = new Map();

  for (const p of people) {
    const tier = p.seniority_tier || classifySeniority(p.title, config);
    out.bySeniority[tier] = (out.bySeniority[tier] || 0) + 1;
    if (tier === 'tier1' || tier === 'tier2') out.icp++;

    const seg = p.segment || segmentOf({ name: p.company_name || '' });
    out.bySegment[seg] = (out.bySegment[seg] || 0) + 1;

    const region = p.region || 'unknown';
    out.byRegion[region] = (out.byRegion[region] || 0) + 1;

    // Recency decides the opener: someone you met last month remembers you.
    let bucket = 'unknown';
    const when = p.connected_on ? Date.parse(p.connected_on) : NaN;
    if (!Number.isNaN(when)) {
      const days = (Date.now() - when) / DAY;
      bucket = days <= 90 ? '0-3 months' : days <= 365 ? '3-12 months'
             : days <= 365 * 3 ? '1-3 years' : '3+ years';
    }
    out.byRecency[bucket] = (out.byRecency[bucket] || 0) + 1;

    if (p.company_name && (tier === 'tier1' || tier === 'tier2')) {
      const key = companyKey(p.company_name);
      if (!companyContacts.has(key)) {
        companyContacts.set(key, { name: p.company_name, contacts: [], openings: p.live_openings || 0, segment: seg });
      }
      companyContacts.get(key).contacts.push({ name: p.name, title: p.title, tier });
    }
  }

  out.reachableIcpCompanies = companyContacts.size;

  // Companies where you have more than one route in are disproportionately
  // valuable — if the first contact goes quiet there is an internal referral.
  out.topCompanies = [...companyContacts.values()]
    .sort((a, b) => b.contacts.length - a.contacts.length || b.openings - a.openings)
    .slice(0, 15);

  out.multiRouteCompanies = [...companyContacts.values()].filter((c) => c.contacts.length > 1).length;

  return out;
}

/**
 * Turns the composition into decisions. Every gap names the search that fills
 * it, so the output is a next action rather than a statistic.
 */
function findGaps(a, config) {
  const gaps = [];
  const staffing = a.bySegment.staffing || 0;

  if (pct(staffing, a.total) < 15) {
    gaps.push({
      issue: `Only ${staffing} staffing/RPO contacts (${pct(staffing, a.total)}% of network)`,
      why: 'Staffing agencies are the highest-fit, fastest-closing segment — shortlist speed is their revenue, not their overhead.',
      action: 'Run the cold lane against "Staffing India" / "Staffing Gulf" searches to build this segment deliberately.',
    });
  }

  const tier1 = a.bySeniority.tier1 || 0;
  if (pct(tier1, a.total) < 10) {
    gaps.push({
      issue: `Only ${tier1} tier-1 decision makers (${pct(tier1, a.total)}%)`,
      why: 'Tier-2 contacts can champion but not sign; deals stall waiting for an internal referral.',
      action: 'Prioritise CHRO/VP-HR and agency-founder searches, and ask warm tier-2 replies for an intro.',
    });
  }

  const stale = a.byRecency['3+ years'] || 0;
  if (pct(stale, a.total) > 50) {
    gaps.push({
      issue: `${pct(stale, a.total)}% of connections are 3+ years old`,
      why: 'They may not remember you. A cold-toned message to an old connection converts worse than to a stranger, because it reads as extraction.',
      action: 'The playbook already has a warmDormant angle for these. Do the view → engage steps before messaging; skipping them here costs more than usual.',
    });
  }

  // Can the network physically support the revenue target?
  const need = requiredSends(config);
  if (a.icp < need) {
    gaps.push({
      issue: `${a.icp} ICP contacts vs ~${need} sends needed per month`,
      why: 'The warm lane alone cannot carry the target at the assumed conversion rates.',
      action: `Either raise conversion (better profile, warmer sequence) or add ~${need - a.icp} ICP contacts via the cold lane over the next few weeks.`,
    });
  }

  return gaps;
}

/** Monthly sends the revenue target implies at warm-lane conversion rates. */
function requiredSends(config) {
  const { targetMonthlyINR, growthPlanINR, enterpriseDealINR, assumedRepeatRate } = config.revenue;
  const growthNeeded = Math.max(0, Math.ceil((targetMonthlyINR - enterpriseDealINR) / growthPlanINR));
  const active = growthNeeded + 1;
  const newPerMonth = Math.max(1, Math.ceil(active * (1 - assumedRepeatRate)));
  // warm funnel: 30% reply → 40% trial → 25% paid
  return Math.ceil(newPerMonth / 0.25 / 0.40 / 0.30);
}

// ---------------------------------------------------------------------------

function report(db, config) {
  const a = analyse(db, config);

  if (!a.total) {
    console.log('\n  No first-degree connections imported yet. Run: npm run warm');
    console.log('  (needs input/Connections.csv — see RUN.md §1.1)\n');
    return a;
  }

  const bar = (n) => '█'.repeat(Math.max(1, Math.round(pct(n, a.total) / 2.5)));
  const line = (label, n) => `    ${label.padEnd(14)} ${String(n).padStart(5)}  ${String(pct(n, a.total)).padStart(3)}%  ${bar(n)}`;

  console.log(`\n═══ Network composition — ${a.total} first-degree connections ═══`);

  console.log('\n  Seniority');
  for (const k of ['tier1', 'tier2', 'tier3', 'other']) {
    if (a.bySeniority[k]) {
      const label = { tier1: 'Decision maker', tier2: 'Champion', tier3: 'HR-adjacent', other: 'Not ICP' }[k];
      console.log(line(label, a.bySeniority[k]));
    }
  }

  console.log('\n  Segment');
  for (const [k, v] of Object.entries(a.bySegment).sort((x, y) => y[1] - x[1])) console.log(line(k, v));

  const regions = Object.entries(a.byRegion).filter(([k]) => k !== 'unknown').sort((x, y) => y[1] - x[1]);
  if (regions.length) {
    console.log('\n  Region (known only — resolved during enrichment)');
    for (const [k, v] of regions) console.log(line(config.regions[k]?.label || k, v));
  }

  console.log('\n  Connected');
  for (const k of ['0-3 months', '3-12 months', '1-3 years', '3+ years', 'unknown']) {
    if (a.byRecency[k]) console.log(line(k, a.byRecency[k]));
  }

  console.log(`\n  ICP contacts: ${a.icp} across ${a.reachableIcpCompanies} companies`);
  console.log(`  Companies with 2+ routes in: ${a.multiRouteCompanies} (referral path if the first contact goes quiet)`);

  if (a.topCompanies.length) {
    console.log('\n  Best-connected accounts:');
    for (const c of a.topCompanies.slice(0, 10)) {
      const who = c.contacts.map((x) => `${x.name} (${x.title || '?'})`).join(', ');
      console.log(`    ${c.contacts.length}× ${c.name.slice(0, 28).padEnd(28)} ${who.slice(0, 60)}`);
    }
  }

  const gaps = findGaps(a, config);
  if (gaps.length) {
    console.log('\n  ── Gaps worth acting on ──');
    for (const g of gaps) {
      console.log(`\n    ! ${g.issue}`);
      console.log(`      ${g.why}`);
      console.log(`      → ${g.action}`);
    }
  } else {
    console.log('\n  ✔ No structural gaps — the network can support the target as-is.');
  }
  console.log('');

  a.gaps = gaps;
  return a;
}

module.exports = { analyse, findGaps, report, requiredSends };
