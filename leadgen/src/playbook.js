/**
 * playbook.js — the sales angles.
 *
 * Hari flagged the token budget as a real constraint, so the expensive path is
 * designed out rather than trimmed: this makes ZERO model calls. It is a matrix
 * of 4 segments × 5 situations = 20 pre-written angles, selected deterministically
 * from data we have already validated.
 *
 * That constraint turned out to improve the output rather than compromise it.
 * A good salesperson does not improvise a fresh pitch for every prospect —
 * they have a small number of angles they know convert, and they pick the right
 * one. Deterministic selection also means the same lead always produces the
 * same draft, so a draft can be reviewed, corrected, and re-generated without
 * drifting underneath you.
 *
 * Every claim below traces to the MinMaxHR buyer's guide: 24 hours instead of
 * 4 days, 8 scored dimensions, explained scores including the zeros, no silent
 * auto-rejection, human decisions with written reasons, free tier of 100
 * resumes. Nothing here outruns that document, because the prospect can check
 * it — and the guide's credibility comes from naming its own poor fit.
 */

// ---------------------------------------------------------------------------
// Situations — which one is true, in priority order
// ---------------------------------------------------------------------------

/**
 * Picks the single most relevant situation. Ordered by how strong a reason it
 * gives the prospect to reply today, not by how flattering it is to us.
 */
function situationOf(company, person, signals) {
  const kinds = new Set(signals.map((s) => s.kind));
  const openings = company.live_openings || 0;
  const warm = (person.degree ?? 3) === 1;

  if (kinds.has('post_engagement')) return 'engaged';
  if (openings >= 40) return 'highVolume';
  if (openings >= 8) return 'activeHiring';
  if (warm && kinds.has('recent_connection')) return 'recentlyConnected';
  return 'warmDormant';
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/**
 * angle(ctx) → { hook, pain, proof }
 * ctx: { first, company, openings, monthly, quarterly, link }
 *
 * The body is assembled in messages.js; this only supplies the argument.
 */
const MATRIX = {
  staffing: {
    highVolume: (c) => ({
      hook: `${c.company} has ${c.openings} mandates live right now.`,
      pain: 'At that spread, submittal speed decides which mandates you keep — and screening is the only part of it that scales badly.',
      proof: 'MinMaxHR ranks and explains every applicant in 24 hours instead of 4 days, so your consultants submit first and can defend every name on the shortlist.',
    }),
    activeHiring: (c) => ({
      hook: `Saw ${c.company} is working ${c.openings} live roles.`,
      pain: 'Agency margin lives or dies on how fast a shortlist goes out, and reading the pile is the slowest step in the chain.',
      proof: 'MinMaxHR ranks every applicant against the JD in 24 hours and prints the reasoning, so a client challenging a submittal gets an answer instead of an opinion.',
    }),
    engaged: (c) => ({
      hook: 'thanks for engaging with the post.',
      pain: 'You would know better than most: the mandate is usually won or lost on how fast a defensible shortlist reaches the client.',
      proof: 'That is the whole reason we built MinMaxHR — every applicant ranked and explained in 24 hours, evidence attached.',
    }),
    recentlyConnected: (c) => ({
      hook: 'good to be connected.',
      pain: 'Since you run placements: how long does a shortlist currently take once the applications land?',
      proof: 'We built MinMaxHR to get that to 24 hours with the reasoning attached, so submittals hold up when a client pushes back.',
    }),
    warmDormant: (c) => ({
      hook: 'it has been a while — hope the desk is busy.',
      pain: 'We have been working with staffing teams on the one step that never gets faster: screening the pile before a shortlist goes out.',
      proof: 'MinMaxHR ranks and explains every applicant in 24 hours instead of 4 days.',
    }),
  },

  enterprise: {
    highVolume: (c) => ({
      hook: `${c.company} has ${c.openings} roles open — roughly ${c.quarterly} hires a quarter.`,
      pain: 'At that volume the first hundred applications per role get real attention and the rest get a glance. The strongest candidate is often still unopened when they accept elsewhere.',
      proof: 'MinMaxHR ranks every applicant against the specific JD and prints the reasoning behind each score, including the zeros — so the decision is defensible to a hiring manager or an auditor.',
    }),
    activeHiring: (c) => ({
      hook: `${c.company} is running ${c.openings} live roles.`,
      pain: 'The cost that never shows up on a budget line is recruiter hours — 40+ a month per recruiter reading documents, which is the least judgement-heavy work they do.',
      proof: 'MinMaxHR ranks and explains every applicant in 24 hours. It sits alongside your ATS; nothing gets switched off to run a pilot.',
    }),
    engaged: (c) => ({
      hook: 'thanks for engaging with the post.',
      pain: 'The question it usually raises for HR leaders: when a hiring manager asks why a candidate was dropped, can anyone reconstruct it?',
      proof: 'MinMaxHR records every decision with a written reason in an append-only log, and prints the evidence behind every score.',
    }),
    recentlyConnected: (c) => ({
      hook: 'good to be connected.',
      pain: 'Curious how your team handles screening volume at the moment — most HR functions at your size have a triage problem rather than a sourcing one.',
      proof: 'We built MinMaxHR to rank and explain every applicant in 24 hours, with your team keeping every decision.',
    }),
    warmDormant: (c) => ({
      hook: 'it has been a while.',
      pain: 'We have been working with HR teams on the screening bottleneck: applications arriving faster than anyone can read them fairly.',
      proof: 'MinMaxHR ranks and explains every applicant in 24 hours instead of 4 days. No auto-rejection — your people still decide.',
    }),
  },

  midmarket: {
    highVolume: (c) => ({
      hook: `${c.company} has ${c.openings} roles open right now.`,
      pain: 'That is a lot of screening for a team that probably is not staffed for it.',
      proof: 'MinMaxHR ranks and explains every applicant against the JD in 24 hours instead of 4 days. The free tier covers 100 resumes — enough to test it on a real role.',
    }),
    activeHiring: (c) => ({
      hook: `Noticed ${c.company} is hiring for around ${c.monthly} roles a month.`,
      pain: 'I would guess screening the first hundred applications is quietly eating your week.',
      proof: 'MinMaxHR ranks and explains every applicant against the JD in 24 hours instead of 4 days.',
    }),
    engaged: (c) => ({
      hook: 'thanks for engaging with the post.',
      pain: 'The screening pile is the part of hiring nobody budgets for and everybody loses time to.',
      proof: 'MinMaxHR ranks and explains every applicant in 24 hours, with the evidence behind each score printed.',
    }),
    recentlyConnected: (c) => ({
      hook: 'good to be connected.',
      pain: `How is hiring going at ${c.company} — is screening volume a problem yet?`,
      proof: 'We built MinMaxHR for exactly that: every applicant ranked and explained in 24 hours.',
    }),
    warmDormant: (c) => ({
      hook: `hope things are going well at ${c.company}.`,
      pain: 'We have been helping HR teams with the screening step: reading the pile before a shortlist goes out.',
      proof: 'MinMaxHR ranks and explains every applicant in 24 hours instead of 4 days.',
    }),
  },

  startup: {
    highVolume: (c) => ({
      hook: `${c.company} is hiring hard — ${c.openings} roles live.`,
      pain: 'Founder-led hiring at that pace means you are personally reading resumes at 11pm.',
      proof: 'MinMaxHR ranks and explains every applicant against your JD in 24 hours, evidence attached.',
    }),
    activeHiring: (c) => ({
      hook: `Saw ${c.company} has ${c.openings} roles open.`,
      pain: 'Without a dedicated talent function, screening lands on whoever can least afford the hours.',
      proof: 'MinMaxHR ranks and explains every applicant in 24 hours, with the evidence behind each score printed.',
    }),
    engaged: (c) => ({
      hook: 'thanks for engaging with the post.',
      pain: 'Hiring your first ten to fifty people is where screening hurts most and tooling helps least.',
      proof: 'MinMaxHR ranks and explains every applicant in 24 hours, reasoning attached.',
    }),
    recentlyConnected: (c) => ({
      hook: 'good to be connected.',
      pain: `How are you handling screening at ${c.company} right now?`,
      proof: 'We built MinMaxHR to rank and explain every applicant in 24 hours.',
    }),
    warmDormant: (c) => ({
      hook: `hope ${c.company} is going well.`,
      pain: 'We have been working with founders on the screening step of hiring.',
      proof: 'MinMaxHR ranks and explains every applicant in 24 hours instead of 4 days.',
    }),
  },
};

/**
 * Selects the angle. Falls back along segment then situation rather than
 * throwing — a missing combination should degrade to a weaker pitch, never
 * block a draft.
 */
function selectAngle(company, person, signals, ctx) {
  const segment = MATRIX[company.segment] ? company.segment : 'midmarket';
  const situation = situationOf(company, person, signals);
  const build = MATRIX[segment][situation] || MATRIX[segment].warmDormant;
  return { segment, situation, ...build(ctx) };
}

module.exports = { selectAngle, situationOf, MATRIX };
