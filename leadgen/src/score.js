/**
 * score.js — the ICP rubric, made explicit and auditable.
 *
 * Rubric from the brief:
 *   90–100  CHRO / VP HR at companies hiring 100+ per quarter
 *   75–89   HR Manager / TA Lead at mid-market with hiring signals
 *   <75     Not a priority
 *
 * Two bands with a gap between them is not a scoring function, so this builds
 * a continuous 0–100 score whose *outputs land in those bands*, and records
 * the reasoning behind every number. That mirrors how MinMaxHR itself scores
 * candidates — an explained score, not a bare one — and it means a lead that
 * scores 74 can be inspected rather than just discarded.
 */

/** Live openings on a careers page → estimated hires per quarter. */
function estimateQuarterlyHires(openings, atsDetected) {
  if (!openings) return atsDetected ? 5 : 0;
  // A live opening is roughly one posting cycle; posting turns over ~monthly,
  // so a quarter sees on the order of 2.5× the live count. Deliberately
  // conservative — over-estimating here inflates scores into the top band.
  return Math.round(openings * 2.5);
}

/** Company-size hint pulled from whatever text we have. Weak but non-zero. */
function sizeHint(lead) {
  const t = `${lead.title || ''} ${lead.company || ''}`.toLowerCase();
  if (/\b(group|enterprise|industries|limited|ltd|corporation)\b/.test(t)) return 'large-ish';
  if (/\b(startup|founder|early stage)\b/.test(t)) return 'small';
  return 'unknown';
}

function scoreLead(lead, config) {
  const s = config.scoring;
  const tier1 = new RegExp(s.tier1TitleRegex, 'i');
  const tier2 = new RegExp(s.tier2TitleRegex, 'i');

  const title = (lead.title || '').toLowerCase();
  const company = (lead.company || '').toLowerCase();
  const location = (lead.location || '').toLowerCase();

  const reasons = [];
  let score = 0;

  // --- 1. Seniority / decision authority (0–55) ------------------------------
  let seniority = 'other';
  if (tier1.test(title)) {
    score += 55; seniority = 'tier1';
    reasons.push('Tier-1 title (CHRO / VP HR / Head of People) — budget authority: +55');
  } else if (tier2.test(title)) {
    score += 45; seniority = 'tier2';
    reasons.push('Tier-2 title (HR Manager / TA Lead / Recruitment Manager) — influencer: +45');
  } else if (/\b(hr|human resources?|people|talent|recruit\w*|hiring|staffing)\b/.test(title)) {
    score += 18; seniority = 'tier3';
    reasons.push('HR-adjacent title, seniority unclear: +18');
  } else {
    reasons.push('Title is not an HR decision-maker: +0');
  }

  // --- 2. Validated hiring volume (0–30) ------------------------------------
  const quarterly = estimateQuarterlyHires(lead.openings, lead.atsDetected);
  lead.estimatedQuarterlyHires = quarterly;

  if (quarterly >= s.highVolumeQuarterlyHires) {
    score += 30;
    reasons.push(`Validated high volume — ~${quarterly} hires/quarter from ${lead.openings} live openings: +30`);
  } else if (lead.openings >= s.midMarketOpenRolesMin) {
    score += 20;
    reasons.push(`Mid-market hiring signal — ${lead.openings} live openings (~${quarterly}/quarter): +20`);
  } else if (lead.openings > 0) {
    score += 10;
    reasons.push(`Low but real hiring activity — ${lead.openings} live openings: +10`);
  } else if (lead.atsDetected) {
    score += 6;
    reasons.push('ATS in place but no countable openings — hiring infrastructure exists: +6');
  } else {
    reasons.push('No hiring volume validated: +0');
  }

  // --- 3. Segment fit (0–10) -------------------------------------------------
  // The buyer's guide names staffing/RPO and 500+ enterprises as strong fits;
  // they feel the shortlist-speed pain commercially, not just operationally.
  if (/\b(staffing|recruitment|recruiting|rpo|manpower|consultanc|talent solutions|hr services)\b/.test(company + ' ' + title)) {
    score += 10;
    reasons.push('Staffing / RPO / recruitment firm — shortlist speed is their revenue: +10');
  } else if (sizeHint(lead) === 'large-ish') {
    score += 6;
    reasons.push('Enterprise-shaped company name — likely multi-recruiter hiring: +6');
  } else {
    score += 3;
    reasons.push('Segment fit neutral: +3');
  }

  // --- 4. Geography (0–5) ----------------------------------------------------
  if (/\b(india|bengaluru|bangalore|mumbai|delhi|chennai|hyderabad|pune|gurgaon|gurugram|noida|kolkata|ahmedabad|coimbatore)\b/.test(location)) {
    score += 5;
    reasons.push('India-based — matches data residency (Mumbai) and pricing: +5');
  } else if (location) {
    reasons.push(`Outside primary geography (${lead.location}): +0`);
  }

  // --- Band guards -----------------------------------------------------------
  // The rubric reserves 90–100 for tier-1 titles at genuinely high-volume
  // employers. Without this, a well-connected Tier-2 lead could drift into the
  // top band on segment and geography points alone.
  if (score >= 90 && !(seniority === 'tier1' && quarterly >= s.highVolumeQuarterlyHires)) {
    score = 89;
    reasons.push('Capped at 89 — top band requires Tier-1 title AND 100+ validated hires/quarter');
  }
  // Symmetrically, the 75–89 band requires a real hiring signal.
  if (score >= 75 && lead.openings === 0 && !lead.atsDetected) {
    score = 74;
    reasons.push('Capped at 74 — priority band requires a validated hiring signal');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let band, action;
  if (score >= 90) {
    band = 'A — Priority'; action = 'Draft outreach now. Lead with volume-specific pain.';
  } else if (score >= config.scoring.priorityThreshold) {
    band = 'B — Qualified'; action = 'Draft outreach. Lead with TA time cost.';
  } else {
    band = 'C — Not a priority'; action = 'Do not contact. Keep for re-scoring if hiring picks up.';
  }

  return { score, band, action, seniority, reasons, estimatedQuarterlyHires: quarterly };
}

module.exports = { scoreLead, estimateQuarterlyHires };
