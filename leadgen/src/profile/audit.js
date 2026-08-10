/**
 * profile/audit.js — the conversion rubric.
 *
 * ── Why this is worth doing before writing another message ─────────────────
 * At 15–20 sends a day, essentially every recipient who considers replying
 * clicks your profile first. The profile is the landing page for the entire
 * outbound operation, and it is the one asset that compounds: a fix here
 * improves every message you will ever send, including the ones already sitting
 * unread in someone's inbox.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * So this rubric is NOT generic profile advice. It scores what a CHRO or agency
 * founder actually sees in the ~8 seconds after clicking through from a cold
 * message, and it weights elements by how much they move a reply toward a trial:
 *
 *   Headline    renders next to every message and comment you send
 *   About       only the first two lines are read before "see more"
 *   Featured    the single place a profile can carry a direct conversion path
 *   Activity    proves you are real and active, or quietly discredits you
 *
 * Every suggested rewrite traces to a claim in the MinMaxHR buyer's guide, so
 * nothing on the profile outruns what the product can defend.
 */

const { ageInDays } = require('./extract');

const CHAR = { good: '✔', warn: '!', bad: '✖' };

function finding(level, element, weight, earned, issue, fix) {
  return { level, element, weight, earned, issue, fix };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkHeadline(p, config) {
  const w = 20;
  const h = (p.headline || '').trim();
  const product = config.product.name;

  if (!h) {
    return finding('bad', 'Headline', w, 0,
      'No headline.',
      `Set it now — it appears beside every message you send. Suggested: "${suggestHeadlines(config)[0]}"`);
  }

  // A headline that is only a job title wastes the highest-traffic string on
  // the account. What converts is who you help + the outcome.
  const isJustTitle = /^(founder|ceo|director|co-?founder|managing director)\b/i.test(h) && h.length < 45;
  const namesOutcome = /(24 hour|24-hour|shortlist|screen|rank|hiring|resume|applicant|time.to.hire)/i.test(h);
  const namesAudience = /(hr|talent|recruit|staffing|hiring|people|agency|chro)/i.test(h);
  const mentionsProduct = new RegExp(product, 'i').test(h);

  let earned = 0;
  const notes = [];
  if (namesAudience) earned += 7; else notes.push('does not name who you help');
  if (namesOutcome) earned += 8; else notes.push('does not name the outcome you produce');
  if (mentionsProduct) earned += 3;
  if (h.length >= 40 && h.length <= 220) earned += 2; else notes.push(`length ${h.length} — aim for 80–200 chars`);

  if (isJustTitle) {
    return finding('bad', 'Headline', w, Math.min(earned, 5),
      `"${h}" — a job title only.`,
      `This string sits next to every message you send and every comment you leave. It is the highest-traffic copy on the account and it is currently spending that traffic on your job title. Replace with one of the options below.`);
  }

  if (earned >= 15) {
    return finding('good', 'Headline', w, earned, `"${h}" — names the audience and the outcome.`, null);
  }

  return finding('warn', 'Headline', w, earned,
    `"${h}" — ${notes.join('; ')}.`,
    'Rewrite so a CHRO reading it sideways in a message thread knows immediately what you do for them.');
}

function checkAbout(p) {
  const w = 15;
  if (!p.aboutSectionPresent || !p.about) {
    return finding('bad', 'About', w, 0,
      'No About section.',
      'The first two lines are the only part read before "see more". Open with the buyer\'s problem, not your company history.');
  }

  const about = p.about.trim();
  const firstTwo = about.split(/\n/).slice(0, 2).join(' ').slice(0, 220);

  let earned = 0;
  const notes = [];
  // Opening with the reader's problem outperforms opening with your bio.
  if (/\b(you|your|teams?|recruiters?|hiring managers?)\b/i.test(firstTwo)) earned += 6;
  else notes.push('opens with you, not the reader');
  if (/(24 hour|24-hour|4 days|screen|shortlist|rank|applicant|resume)/i.test(firstTwo)) earned += 5;
  else notes.push('no concrete outcome in the visible opening');
  if (about.length > 300) earned += 2; else notes.push('very short');
  if (/(minmaxhr|candidranker|habsolutions|minmaxhr\.com)/i.test(about)) earned += 2;
  else notes.push('no link or product name');

  if (earned >= 11) return finding('good', 'About', w, earned, 'Opens with the reader\'s problem and a concrete outcome.', null);

  return finding(earned >= 6 ? 'warn' : 'bad', 'About', w, earned,
    `First two lines: "${firstTwo}${about.length > 220 ? '…' : ''}" — ${notes.join('; ')}.`,
    'Rewrite the opening two lines. See the suggested copy below.');
}

function checkFeatured(p, config) {
  const w = 20;
  if (!p.featuredSectionPresent || p.featuredCount === 0) {
    return finding('bad', 'Featured', w, 0,
      'No Featured section.',
      `This is the biggest single gap available to you. Featured is the only place on a profile that can hold a *direct conversion path* — someone arrives from your message, and one click later they have the buyer's guide or a free shortlist. Add: (1) the MinMaxHR Buyer's Guide PDF, (2) a link to ${config.product.trialLink} labelled "Free ranked shortlist in 24 hours", (3) one ranked-shortlist sample report with the client details removed.`);
  }

  const items = p.featuredItems.join(' ').toLowerCase();
  let earned = 6;
  const missing = [];
  if (/guide|pdf|buyer/.test(items)) earned += 5; else missing.push("the buyer's guide");
  if (/free|trial|shortlist|24 hour/.test(items)) earned += 5; else missing.push('the free-shortlist offer');
  if (/report|sample|case/.test(items)) earned += 4; else missing.push('a sample ranked report');

  if (!missing.length) return finding('good', 'Featured', w, earned, `${p.featuredCount} items, including a conversion path.`, null);

  return finding('warn', 'Featured', w, earned,
    `${p.featuredCount} item(s), but missing ${missing.join(', ')}.`,
    'Featured is prime conversion space. Every item should be something a prospect can act on immediately.');
}

function checkActivity(activity) {
  const w = 15;
  if (!activity || activity.count === 0) {
    return finding('bad', 'Recent activity', w, 0,
      'No recent posts found.',
      'A prospect who clicks through from your message and sees an empty feed quietly discounts you — it reads as an account that exists only to pitch. Two posts a week is enough. Post the things you already know: what a defensible shortlist looks like, why screening the first 100 applications is a lottery, what an explained score contains.');
  }

  const ages = activity.posts.map(ageInDays).filter((d) => d !== null);
  const newest = ages.length ? Math.min(...ages) : null;
  const withinMonth = ages.filter((d) => d <= 30).length;
  const avgReactions = Math.round(
    activity.posts.reduce((s, p) => s + (p.reactions || 0), 0) / Math.max(1, activity.posts.length)
  );

  let earned = 0;
  const notes = [];
  if (newest !== null && newest <= 7) earned += 6;
  else if (newest !== null && newest <= 30) { earned += 3; notes.push(`last post ~${Math.round(newest)} days ago`); }
  else notes.push(`last post ~${newest ? Math.round(newest) : '?'} days ago — reads as dormant`);

  if (withinMonth >= 8) earned += 6;
  else if (withinMonth >= 4) earned += 4;
  else notes.push(`only ${withinMonth} post(s) in the last 30 days`);

  if (avgReactions >= 20) earned += 3;
  else if (avgReactions >= 5) earned += 2;
  else notes.push(`average ${avgReactions} reactions — low reach`);

  const level = earned >= 12 ? 'good' : earned >= 6 ? 'warn' : 'bad';
  return finding(level, 'Recent activity', w, earned,
    notes.length ? notes.join('; ') : `${withinMonth} posts in 30 days, ~${avgReactions} reactions each.`,
    level === 'good' ? null
      : 'Two posts a week, aimed squarely at HR and staffing leaders. Every post also feeds the engagement lane — people who react become your warmest, highest-scoring leads.');
}

function checkBanner(p) {
  const w = 10;
  if (!p.hasBanner) {
    return finding('bad', 'Banner', w, 0,
      'Default banner.',
      'Free advertising on every profile view, currently blank. Put the offer on it: "Every applicant ranked and explained in 24 hours — free on your first role. minmaxhr.com".');
  }
  return finding('good', 'Banner', w, w, 'Custom banner set.', 'Check it states the offer, not just branding.');
}

function checkCta(p, config) {
  const w = 8;
  if (!p.cta) {
    return finding('bad', 'CTA button', w, 0,
      'No custom button.',
      `Add a "Visit my website" button pointing at ${config.product.trialLink}. It sits directly under your headline — the first thing a prospect can click.`);
  }
  const pointsRight = new RegExp('minmaxhr|habsolutions', 'i').test(p.cta.href || '');
  return pointsRight
    ? finding('good', 'CTA button', w, w, `"${p.cta.label}" → ${p.cta.href}`, null)
    : finding('warn', 'CTA button', w, 4, `"${p.cta.label}" → ${p.cta.href}`, `Point it at ${config.product.trialLink}.`);
}

function checkSocialProof(p) {
  const w = 7;
  let earned = 0;
  const notes = [];
  if (p.recommendationsCount >= 3) earned += 4;
  else notes.push(`${p.recommendationsCount} recommendations — ask 3 clients, it takes them 5 minutes`);
  if (p.skillsCount >= 5) earned += 3; else notes.push(`${p.skillsCount} skills listed`);

  const level = earned >= 6 ? 'good' : earned >= 3 ? 'warn' : 'bad';
  return finding(level, 'Social proof', w, earned,
    notes.length ? notes.join('; ') : 'Recommendations and skills in place.',
    level === 'good' ? null : 'Recommendations from HR or staffing clients specifically — a recommendation from a peer founder does not reassure a CHRO.');
}

function checkBasics(p) {
  const w = 5;
  let earned = 0;
  const notes = [];
  if (p.hasPhoto) earned += 3; else notes.push('no profile photo');
  if (p.followers && p.followers > 500) earned += 2;
  else if (p.followers) notes.push(`${p.followers} followers`);

  return finding(earned >= 4 ? 'good' : 'warn', 'Basics', w, earned,
    notes.length ? notes.join('; ') : 'Photo and reach fine.', null);
}

// ---------------------------------------------------------------------------
// Suggested copy — every claim traceable to the buyer's guide
// ---------------------------------------------------------------------------

function suggestHeadlines(config) {
  return [
    `Helping staffing agencies and HR teams shortlist in 24 hours instead of 4 days | Founder, ${config.product.senderCompany} | ${config.product.name}`,
    `I help HR and TA teams stop reading resume piles — every applicant ranked and explained in 24 hours | ${config.product.name}`,
    `Founder, ${config.product.senderCompany} | ${config.product.name} ranks and explains every applicant against your JD in 24 hours — evidence attached`,
  ];
}

function suggestAbout(config) {
  return [
    `Most hiring teams don't have a sourcing problem. They have a triage problem — applications arrive faster than anyone can read them fairly, so the first fifty get real attention and the strongest candidate accepts elsewhere while their file is still unopened.`,
    ``,
    `I built ${config.product.name} to fix the expensive part of that: every applicant scored against your specific job description across eight dimensions, with the reasoning printed for every number — including the zeros. Ranking arrives in 24 hours instead of 4 days.`,
    ``,
    `What it is not: an ATS, a sourcing agency, or an auto-rejection engine. The engine ranks and explains; your people decide, and every decision is recorded with a written reason. That split is architectural, not a setting.`,
    ``,
    `Free on one live role — 100 resumes, no card: ${config.product.trialLink}`,
    `— ${config.product.senderName}, ${config.product.senderTitle}, ${config.product.senderCompany}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------

function audit(profile, activity, config) {
  const findings = [
    checkHeadline(profile, config),
    checkFeatured(profile, config),
    checkAbout(profile),
    checkActivity(activity),
    checkBanner(profile),
    checkCta(profile, config),
    checkSocialProof(profile),
    checkBasics(profile),
  ];

  const total = findings.reduce((s, f) => s + f.weight, 0);
  const earned = findings.reduce((s, f) => s + f.earned, 0);
  const score = Math.round((earned / total) * 100);

  // Ordered by how much score is recoverable — biggest wins first, which is
  // also the order to actually do the work in.
  const priorities = findings
    .filter((f) => f.fix)
    .sort((a, b) => (b.weight - b.earned) - (a.weight - a.earned));

  return { score, earned, total, findings, priorities };
}

function report(result, profile, config) {
  console.log(`\n═══ Profile conversion audit — ${profile.name || 'your profile'} ═══`);
  console.log(`\n  Score: ${result.score}/100  (${result.earned} of ${result.total} weighted points)`);
  console.log('  Scored for outbound conversion — what a CHRO sees 8 seconds after clicking your message.\n');

  for (const f of result.findings) {
    const icon = CHAR[f.level];
    console.log(`  ${icon} ${f.element.padEnd(16)} ${String(f.earned).padStart(2)}/${String(f.weight).padEnd(3)} ${f.issue}`);
  }

  console.log('\n  ── Do these, in this order ──');
  result.priorities.slice(0, 5).forEach((f, i) => {
    console.log(`\n  ${i + 1}. ${f.element}  (+${f.weight - f.earned} points available)`);
    console.log(`     ${f.fix}`);
  });

  console.log('\n  ── Suggested headline options ──');
  suggestHeadlines(config).forEach((h, i) => console.log(`\n  ${i + 1}. ${h}`));

  console.log('\n  ── Suggested About ──\n');
  console.log(suggestAbout(config).split('\n').map((l) => '  ' + l).join('\n'));
  console.log('\n  Nothing above outruns the buyer\'s guide — every claim is one a prospect can check.\n');
}

module.exports = { audit, report, suggestHeadlines, suggestAbout };
