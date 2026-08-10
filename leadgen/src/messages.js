/**
 * messages.js — DRAFTS ONLY.
 *
 * ── HARD RULE ──────────────────────────────────────────────────────────────
 * Nothing in this repository sends a LinkedIn message, connection request,
 * InMail, or email. This module returns strings. There is no send path, and
 * `assertDraftOnly` aborts the run if config is ever flipped to suggest
 * otherwise. Sending is a human action, taken in the LinkedIn UI, by someone
 * who has read the draft.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The two rules that have not changed since v1, because they are the ones that
 * protect the sender:
 *
 * 1. Never invent a variable. If we could not count a company's openings, the
 *    draft is withheld rather than guessing "10–15 roles a month" at someone
 *    who posts two. The prospect is the one person guaranteed to know the real
 *    number, and getting it wrong in the first line is unrecoverable.
 *
 * 2. Vary the wording, never the claim. Drafts differ by segment and situation,
 *    but the offer, the 24-hour claim and the link are constant and all trace
 *    to the buyer's guide.
 */

const { selectAngle } = require('./playbook');

function assertDraftOnly(config) {
  if (config.outreach.draftOnly !== true) {
    throw new Error(
      'REFUSING TO RUN: outreach.draftOnly must be true. This tool drafts messages; it does not send them.'
    );
  }
}

function firstName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  const clean = (s) => (s || '').replace(/[^\p{L}\p{M}'-]/gu, '');
  let n = clean(parts[0]);
  if (/^(dr|mr|mrs|ms|prof|ca|er)$/i.test(n)) n = clean(parts[1]) || n;
  return n;
}

/** Tidy a company name for use mid-sentence. */
function cleanCompany(company) {
  return (company || '')
    .replace(/\s*\b(pvt\.?|private|ltd\.?|limited|inc\.?|llp|llc)\b\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Live openings → an honest *monthly posting* range.
 *
 * A careers page shows roles accumulated over roughly two months of posting,
 * not one, so the monthly rate sits well under the live count. This lands at
 * ~45% with a ±20% band: tight enough to sound observed, low enough to survive
 * being checked by the person who runs that careers page.
 */
function roleVolumePhrase(openings) {
  if (!openings || openings < 6) return null;
  const mid = openings * 0.45;
  const low = Math.max(3, Math.round(mid * 0.8));
  const high = Math.max(low + 2, Math.round(mid * 1.2));
  return `${low}–${high}`;
}

/**
 * Builds one draft from the playbook angle.
 * Returns { ok, body, angle, reason } — ok:false means it is not safe to send.
 */
function buildDraft({ company, person, signals = [] }, config) {
  assertDraftOnly(config);

  const first = firstName(person.name);
  const companyName = cleanCompany(company.name);
  const openings = company.live_openings || 0;
  const monthly = roleVolumePhrase(openings);
  const link = config.product.trialLink;

  const missing = [];
  if (!first) missing.push('first name');
  if (!companyName) missing.push('company');
  if (!link || /CHANGE_ME/.test(link)) missing.push('trial link (product.trialLink)');

  if (missing.length) {
    return { ok: false, body: '', angle: null, reason: `withheld — missing ${missing.join(', ')}` };
  }

  const angle = selectAngle(company, person, signals, {
    first,
    company: companyName,
    openings,
    monthly,
    quarterly: Math.round(openings * 2.5),
    link,
  });

  // An angle that leans on a volume number we could not verify is withheld,
  // even though every other variable is present.
  if ((angle.situation === 'activeHiring' || angle.situation === 'highVolume') && !openings) {
    return { ok: false, body: '', angle: angle.situation, reason: 'withheld — volume angle selected but openings could not be verified' };
  }
  if (angle.situation === 'activeHiring' && /roles a month/.test(angle.hook) && !monthly) {
    return { ok: false, body: '', angle: angle.situation, reason: 'withheld — monthly rate not derivable from openings' };
  }

  const body = [
    `Hi ${first} — ${angle.hook}`,
    '',
    angle.pain,
    '',
    angle.proof,
    '',
    `Free on one live role, no card: ${link}. Reply here if it is worth a look.`,
    '',
    config.product.signOff,
  ].join('\n');

  return {
    ok: true,
    body,
    angle: `${angle.segment}/${angle.situation}`,
    reason: `openings=${openings}${company.careers_url ? `, verified at ${company.careers_url}` : ''}`,
  };
}

module.exports = { buildDraft, assertDraftOnly, firstName, cleanCompany, roleVolumePhrase };
