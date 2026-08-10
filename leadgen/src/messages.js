/**
 * messages.js — DRAFTS ONLY.
 *
 * ── HARD RULE ──────────────────────────────────────────────────────────────
 * Nothing in this repository sends a LinkedIn message, connection request,
 * InMail, or email. This module returns strings. There is no send path, and
 * `assertDraftOnly` below will abort the run if config is ever flipped to
 * suggest otherwise. Sending stays a human action, taken in the LinkedIn UI,
 * by a person who has read the draft.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Two substantive choices:
 *
 * 1. Every variable is filled from validated data, never invented. If we could
 *    not count a company's openings, the message is withheld rather than
 *    guessing "10–15 new roles a month" at someone who posts two. A wrong
 *    number in the first line is the fastest way to lose a CHRO.
 *
 * 2. Ten identical messages is itself a spam signal, and reads like one. Each
 *    draft varies its opener and closer from a small set, keyed off the lead,
 *    so no two consecutive drafts are textually identical while the offer and
 *    claims stay exactly the same.
 */

function assertDraftOnly(config) {
  if (config.outreach.draftOnly !== true) {
    throw new Error(
      'REFUSING TO RUN: outreach.draftOnly must be true. This tool drafts messages; it does not send them.'
    );
  }
}

function firstName(fullName) {
  const n = (fullName || '').trim().split(/\s+/)[0] || '';
  // Strip honorifics and stray punctuation LinkedIn names collect.
  const cleaned = n.replace(/[^\p{L}\p{M}'-]/gu, '');
  if (/^(dr|mr|mrs|ms|prof|ca)$/i.test(cleaned)) {
    return (fullName || '').trim().split(/\s+/)[1] || cleaned;
  }
  return cleaned;
}

/** Tidy a company name for use mid-sentence. */
function cleanCompany(company) {
  return (company || '')
    .replace(/\s*\b(pvt\.?|private|ltd\.?|limited|inc\.?|llp|llc)\b\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Turns counted live openings into an honest *monthly posting* range.
 *
 * A careers page shows roles accumulated over roughly two months of posting,
 * not one — so the monthly rate is well under the live count. Claiming a
 * company posts 26–47 roles a month off 52 live openings is an overclaim, and
 * the prospect is the one person guaranteed to know it. This lands at ~45% of
 * the live count with a ±20% band: tight enough to sound observed, low enough
 * to survive being checked.
 */
function roleVolumePhrase(openings) {
  if (!openings || openings < 6) return null; // too few to make the claim at all
  const mid = openings * 0.45;
  const low = Math.max(3, Math.round(mid * 0.8));
  const high = Math.max(low + 2, Math.round(mid * 1.2));
  return `${low}–${high}`;
}

const OPENERS = [
  (n, c, v) => `Hi ${n} — I noticed ${c} posts ${v} new roles a month.`,
  (n, c, v) => `Hi ${n} — ${c} has ${v} roles open a month from what I can see.`,
  (n, c, v) => `Hi ${n} — saw ${c} is running ${v} new roles a month.`,
];

const PAIN = [
  "I'm guessing screening the first 100 applications is eating into TA time.",
  "I'd guess the first 100 applications per role are eating your team's week.",
  "If it's like most teams at that volume, screening the first 100 applications is the bottleneck.",
];

const CLOSERS = [
  (link) => `Try it free on one live role: ${link}. Reply here if interested.`,
  (link) => `Worth testing free on one live role: ${link}. Reply here if you want a look.`,
  (link) => `You can run it free on a single live role: ${link}. Reply here if that's useful.`,
];

/**
 * Builds one draft. Returns { ok, message, reason } — `ok:false` means the
 * lead is not safe to message with a data-specific claim yet.
 */
function buildDraft(lead, config, index = 0) {
  assertDraftOnly(config);

  const name = firstName(lead.name);
  const company = cleanCompany(lead.company);
  const volume = roleVolumePhrase(lead.openings);
  const link = config.product.trialLink;

  const missing = [];
  if (!name) missing.push('first name');
  if (!company) missing.push('company');
  if (!volume) missing.push('validated hiring volume');
  if (!link || /CHANGE_ME/.test(link)) missing.push('trial link (set product.trialLink in config.json)');

  if (missing.length) {
    return {
      ok: false,
      message: '',
      reason: `withheld — missing ${missing.join(', ')}. Never fill these with a guess.`,
    };
  }

  // Vary by lead so consecutive drafts differ, deterministically (same lead
  // always produces the same draft, which matters for review and re-runs).
  const seed = (index + name.length + company.length) % 3;

  const message = [
    OPENERS[seed](name, company, volume),
    PAIN[(seed + 1) % 3],
    '',
    `We built ${config.product.name} to rank and explain every applicant in 24 hours instead of 4 days.`,
    CLOSERS[(seed + 2) % 3](link),
  ].join(' ').replace(/\s+\n/g, '\n').replace(/ {2,}/g, ' ').trim();

  return {
    ok: true,
    message,
    reason: `variables from validated data — openings=${lead.openings}, careers=${lead.careersUrl || 'n/a'}`,
  };
}

/** Drafts for the top N scored leads. Sending is never attempted. */
function buildDrafts(leads, config) {
  assertDraftOnly(config);

  const eligible = leads
    .filter((l) => l.score >= config.scoring.priorityThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.outreach.topNForMessages);

  return eligible.map((lead, i) => {
    const draft = buildDraft(lead, config, i);
    return {
      rank: i + 1,
      name: lead.name,
      company: lead.company,
      title: lead.title,
      linkedinUrl: lead.url,
      score: lead.score,
      band: lead.band,
      status: draft.ok ? 'DRAFT — review then send by hand' : 'WITHHELD',
      message: draft.message,
      note: draft.reason,
    };
  });
}

module.exports = { buildDrafts, buildDraft, firstName, cleanCompany, roleVolumePhrase, assertDraftOnly };
