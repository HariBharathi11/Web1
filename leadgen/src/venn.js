/**
 * venn.js — Account Priority Score.
 *
 * The brief asked for the opportunity to be "mapped like a Venn diagram".
 * This is that, made computable. Three independent axes:
 *
 *   Fit     — is this company worth selling to at all?
 *   Access  — can we actually reach a decision maker there?
 *   Timing  — is the pain live right now?
 *
 *   priority = fit^0.40 × access^0.35 × timing^0.25   (weighted geometric mean)
 *
 * Geometric, not additive, and that choice is the whole design:
 *
 *   A perfect-fit enterprise you have no route into scores ~0.
 *   A warm first-degree contact at a company that is not hiring scores ~0.
 *   A hiring company you cannot reach and do not fit scores ~0.
 *
 * Only the *intersection* survives — which is what a Venn diagram means, and
 * what an additive score would quietly destroy by letting two strong axes carry
 * a dead one. Outreach capacity is the scarce resource (15–20 sends a day by
 * hand); this decides where it goes.
 *
 * Every axis returns written reasoning alongside its number, matching how
 * MinMaxHR itself scores candidates — an explained score, never a bare one.
 */

// ---------------------------------------------------------------------------
// Region
// ---------------------------------------------------------------------------

/** Classify a free-text location into a configured region key. */
function regionOf(location, config) {
  const loc = (location || '').toLowerCase();
  if (!loc) return 'OTHER';
  for (const [key, r] of Object.entries(config.regions)) {
    if (key === 'OTHER' || !r.match) continue;
    if (new RegExp(r.match, 'i').test(loc)) return key;
  }
  return 'OTHER';
}

/**
 * Segment, derived from the COMPANY NAME only.
 *
 * Deliberately ignores employee titles. Every company of any size has a
 * "Recruitment Manager", so reading titles would classify Infosys as a staffing
 * agency — which then hands it the +40 staffing bonus and corrupts the whole
 * Fit axis. Being an agency is a property of the business, and the business
 * name is where it shows up.
 */
function segmentOf(company) {
  const name = (company.name || '').toLowerCase();
  if (/\b(staffing|recruit\w*|rpo|manpower|talent solutions|hr services|placement|headhunt\w*|search (firm|partners)|hr consult\w*|talent partners|workforce)\b/.test(name)) {
    return 'staffing';
  }
  if (/\b(group|industries|corporation|enterprises|holdings|international|systems|motors|bank|pharma)\b/.test(name)) return 'enterprise';
  return 'midmarket';
}

// ---------------------------------------------------------------------------
// Axis 1 — Fit
// ---------------------------------------------------------------------------

/**
 * Is this company worth selling to? Segment, validated hiring volume, and the
 * regional value of the deal. Blockers are recorded, not hidden.
 */
function scoreFit(company, people, config) {
  const reasons = [];
  const blockers = [];
  let raw = 0;

  const segment = company.segment || segmentOf(company, people);
  const region = company.region || 'OTHER';
  const openings = company.live_openings || 0;

  // --- segment (0–40) ---
  if (segment === 'staffing') {
    raw += 40;
    reasons.push('Staffing / RPO / recruitment firm — shortlist speed is their revenue, not their overhead: +40');
  } else if (segment === 'enterprise') {
    raw += 30;
    reasons.push('Enterprise — multi-recruiter hiring, needs auditable consistency across role families: +30');
  } else if (segment === 'midmarket') {
    raw += 22;
    reasons.push('Mid-market — applicant volume outruns the hours available to read it: +22');
  } else {
    raw += 12;
    reasons.push('Startup / small team — real fit but small deal and high churn: +12');
  }

  // --- validated hiring volume (0–40) ---
  if (openings >= 40) {
    raw += 40;
    reasons.push(`High volume — ${openings} live openings (~${Math.round(openings * 2.5)} hires/quarter): +40`);
  } else if (openings >= config.scoring.midMarketOpenRolesMin) {
    raw += 28;
    reasons.push(`Mid-market hiring signal — ${openings} live openings: +28`);
  } else if (openings > 0) {
    raw += 14;
    reasons.push(`Low but real hiring activity — ${openings} live openings: +14`);
  } else if (company.ats) {
    raw += 8;
    reasons.push(`ATS in place (${company.ats}) but no countable openings — infrastructure exists: +8`);
  } else {
    reasons.push('No hiring volume validated: +0');
  }

  // --- team size proxy (0–20): several ICP people is itself a size signal ---
  const icpCount = people.filter((p) => p.seniority_tier === 'tier1' || p.seniority_tier === 'tier2').length;
  if (icpCount >= 3) { raw += 20; reasons.push(`${icpCount} ICP contacts mapped — a real HR function, not one generalist: +20`); }
  else if (icpCount === 2) { raw += 13; reasons.push('2 ICP contacts mapped: +13'); }
  else if (icpCount === 1) { raw += 7; reasons.push('1 ICP contact mapped: +7'); }

  // --- regional value multiplier ---
  const rcfg = config.regions[region] || config.regions.OTHER;
  const beforeRegion = raw;
  raw = raw * rcfg.multiplier;
  reasons.push(`${rcfg.label} — deal-value multiplier ×${rcfg.multiplier}: ${Math.round(beforeRegion)} → ${Math.round(raw)}`);

  // --- blockers ---
  // The buyer's guide is explicit that MinMaxHR does not clear a hard SOC 2
  // gate today. Pitching a US/EU enterprise that will hit that gate at
  // procurement wastes the send and, worse, the credibility. Downgrade it
  // openly rather than discovering it three weeks into diligence.
  if ((region === 'US' || region === 'EU') && segment === 'enterprise') {
    blockers.push('SOC 2 not yet certified — likely hard procurement gate for US/EU enterprise');
    raw *= 0.45;
    reasons.push('SOC 2 gate likely for US/EU enterprise — downgraded ×0.45 (target staffing agencies in these regions instead)');
  }
  if (region === 'EU') {
    blockers.push('GDPR transfer review needed — data processed in Mumbai (defensible, but adds a step)');
  }

  const fit = Math.max(0, Math.min(100, Math.round(raw)));
  return { fit, reasons, blockers, segment, region };
}

// ---------------------------------------------------------------------------
// Axis 2 — Access
// ---------------------------------------------------------------------------

/**
 * Can we actually reach someone who can say yes? This is the axis that makes
 * the warm network worth more than any amount of cold search: a first-degree
 * connection is a message that gets read, not a connection request that sits.
 */
function scoreAccess(company, people, config, signalsByPerson = {}) {
  const reasons = [];
  const v = config.venn;

  if (!people.length) {
    return { access: 0, reasons: ['No contact mapped at this company — nothing to act on: 0'] };
  }

  // Best reachable decision maker drives the axis.
  const decisionMakers = people.filter((p) => p.seniority_tier === 'tier1');
  const influencers = people.filter((p) => p.seniority_tier === 'tier2');
  const pool = decisionMakers.length ? decisionMakers : (influencers.length ? influencers : people);

  const best = pool.reduce((a, b) => ((a.degree ?? 3) <= (b.degree ?? 3) ? a : b));
  const degree = best.degree ?? 3;

  let access = v.accessByDegree[String(degree)] ?? 30;
  const degreeLabel = degree === 1 ? '1st-degree connection' : degree === 2 ? '2nd-degree' : 'cold / 3rd-degree';
  reasons.push(`Best route is ${best.name} (${best.title || 'title unknown'}) — ${degreeLabel}: ${access}`);

  if (!decisionMakers.length && influencers.length) {
    access -= 12;
    reasons.push('Route is an influencer, not a budget holder — needs an internal referral: −12');
  } else if (!decisionMakers.length && !influencers.length) {
    access -= 30;
    reasons.push('No HR decision maker or influencer mapped yet: −30');
  }

  if (signalsByPerson[best.id]?.engaged) {
    access += v.accessEngagedBonus;
    reasons.push(`Engaged with your content — warm opener available: +${v.accessEngagedBonus}`);
  }

  const routes = people.filter((p) => (p.degree ?? 3) === 1).length;
  if (routes >= 2) {
    access += v.accessMultiContactBonus;
    reasons.push(`${routes} first-degree routes into this company — referral path if the first goes quiet: +${v.accessMultiContactBonus}`);
  }

  return { access: Math.max(0, Math.min(100, Math.round(access))), reasons, bestPersonId: best.id };
}

// ---------------------------------------------------------------------------
// Axis 3 — Timing
// ---------------------------------------------------------------------------

/**
 * Is the pain live *now*? A company that fits perfectly and is reachable but
 * has no live hiring has nothing to buy this quarter. This is the axis that
 * stops the pipeline filling with technically-correct dead leads.
 */
function scoreTiming(company, signals = []) {
  const reasons = [];
  let timing = 0;

  const openings = company.live_openings || 0;
  const kinds = new Set(signals.map((s) => s.kind));

  if (openings >= 40) { timing += 55; reasons.push(`${openings} roles open right now — screening load is live: +55`); }
  else if (openings >= 15) { timing += 42; reasons.push(`${openings} roles open right now: +42`); }
  else if (openings >= 5) { timing += 28; reasons.push(`${openings} roles open right now: +28`); }
  else if (openings > 0) { timing += 12; reasons.push(`${openings} role(s) open: +12`); }
  else { reasons.push('No live openings found — nothing to screen this quarter: +0'); }

  if (company.ats) { timing += 15; reasons.push(`Running ${company.ats} — already tooling-aware, shorter education cycle: +15`); }
  if (kinds.has('funding')) { timing += 20; reasons.push('Recent funding — hiring spike typically follows within 60 days: +20'); }
  if (kinds.has('new_leader')) { timing += 15; reasons.push('New HR leader in seat — new leaders buy tools in their first 90 days: +15'); }
  if (kinds.has('post_engagement')) { timing += 12; reasons.push('Recently posted about hiring or screening load — pain is top of mind: +12'); }

  // Staleness: a hiring count from two months ago is not a "now" signal.
  if (company.openings_checked_at) {
    const days = (Date.now() - new Date(company.openings_checked_at)) / 86400000;
    if (days > 30) {
      timing *= 0.7;
      reasons.push(`Hiring data is ${Math.round(days)} days old — discounted ×0.7 until re-validated`);
    }
  }

  return { timing: Math.max(0, Math.min(100, Math.round(timing))), reasons };
}

// ---------------------------------------------------------------------------
// Combine
// ---------------------------------------------------------------------------

function scoreAccount(company, people, signals, config, signalsByPerson = {}) {
  const f = scoreFit(company, people, config);
  const a = scoreAccess(company, people, config, signalsByPerson);
  const t = scoreTiming(company, signals);

  const w = config.venn.weights;

  // Weighted geometric mean. Any zero axis zeroes the account — deliberately.
  const priority = Math.round(
    Math.pow(Math.max(f.fit, 0.01), w.fit) *
    Math.pow(Math.max(a.access, 0.01), w.access) *
    Math.pow(Math.max(t.timing, 0.01), w.timing)
  );

  let band, next_action;
  if (priority >= config.venn.bandA) {
    band = 'A';
    next_action = 'Draft now. Start the touch sequence today.';
  } else if (priority >= config.venn.bandB) {
    band = 'B';
    next_action = 'Draft second. Send after Band A is worked.';
  } else {
    band = 'C';
    const weakest = [['fit', f.fit], ['access', a.access], ['timing', t.timing]].sort((x, y) => x[1] - y[1])[0];
    next_action = `Hold — weakest axis is ${weakest[0]} (${weakest[1]}). Do not contact.`;
  }

  return {
    fit: f.fit, access: a.access, timing: t.timing, priority, band, next_action,
    segment: f.segment, region: f.region, blockers: f.blockers,
    bestPersonId: a.bestPersonId,
    reasoning: { fit: f.reasons, access: a.reasons, timing: t.reasons },
  };
}

module.exports = { scoreAccount, scoreFit, scoreAccess, scoreTiming, regionOf, segmentOf };
