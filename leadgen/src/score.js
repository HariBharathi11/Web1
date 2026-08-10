/**
 * score.js — person classification.
 *
 * Company-level scoring moved to venn.js when the model became account-based;
 * what remains here is the one job that is genuinely about an individual:
 * deciding what a person's title makes them to us.
 *
 *   tier1 — can sign. CHRO, VP HR, Head of People, and (for agencies) the
 *           founder or MD, because at a 20-person staffing firm the founder IS
 *           the buyer and treating them as "not HR" loses the best segment.
 *   tier2 — feels the pain and can champion it. HR Manager, TA Lead, HRBP.
 *   tier3 — HR-adjacent, unclear seniority. Worth mapping, not worth messaging.
 *   other — not a route in.
 *
 * This feeds the Access axis, which is where seniority actually matters:
 * a tier-1 you cannot reach is worth less than a tier-2 who will reply.
 */

function classifySeniority(title, config) {
  const t = (title || '').toLowerCase();
  if (!t) return 'other';

  if (new RegExp(config.scoring.tier1TitleRegex, 'i').test(t)) return 'tier1';
  if (new RegExp(config.scoring.tier2TitleRegex, 'i').test(t)) return 'tier2';
  if (/\b(hr|human resources?|people|talent|recruit\w*|hiring|staffing)\b/.test(t)) return 'tier3';
  return 'other';
}

/** Is this person worth spending a profile visit or a message on? */
function isICP(title, config) {
  const tier = classifySeniority(title, config);
  return tier === 'tier1' || tier === 'tier2';
}

/**
 * Cheap pre-score from a search card alone, so profile visits — the scarcest
 * resource in a cold run — are spent only on plausible leads.
 */
function preScore(headline, config) {
  const tier = classifySeniority(headline, config);
  return { tier1: 3, tier2: 2, tier3: 1, other: 0 }[tier];
}

/** Live openings on a careers page → estimated hires per quarter. */
function estimateQuarterlyHires(openings, atsDetected) {
  if (!openings) return atsDetected ? 5 : 0;
  // A live opening is roughly one posting cycle; posting turns over ~monthly,
  // so a quarter sees on the order of 2.5× the live count. Deliberately
  // conservative — over-estimating inflates the Fit axis.
  return Math.round(openings * 2.5);
}

module.exports = { classifySeniority, isICP, preScore, estimateQuarterlyHires };
