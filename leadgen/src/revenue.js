/**
 * revenue.js — maps the pipeline to the money target.
 *
 * The objective is ₹1,00,000 a month from MinMaxHR. This works backwards from
 * that number to how many Band A/B accounts have to exist, and compares it to
 * what is actually in the database right now — so the answer to "are we on
 * track?" is a number, not a feeling.
 *
 * ── One thing that has to be said plainly ──────────────────────────────────
 * The buyer's guide states that paid plans are ONE-TIME payments activating a
 * 30-day period, with no auto-renewal and nothing to cancel. That is a genuinely
 * good commercial promise, and it means MinMaxHR does not have MRR in the
 * subscription sense: nobody is billed again unless they choose to buy again.
 *
 * So ₹1,00,000 "MRR" is really ₹1,00,000 of *repeat monthly revenue*, and it
 * has to be re-won every 30 days. Modelling it as subscription MRR would
 * overstate the position badly — you would hit the number once and watch it
 * decay. The maths below therefore treats repeat purchase as the core variable,
 * because it is the one that decides whether this holds or slides.
 * ───────────────────────────────────────────────────────────────────────────
 */

const DB = require('./db');

/**
 * Steady state: active_next = active × repeat + new.
 * For the target to hold rather than decay, new must cover the churn gap.
 */
function steadyState(activeNeeded, repeatRate) {
  return activeNeeded * (1 - repeatRate);
}

/** Months to build from zero to `target` active clients at `perMonth` new. */
function rampMonths(target, perMonth, repeatRate, cap = 36) {
  let active = 0;
  for (let m = 1; m <= cap; m++) {
    active = active * repeatRate + perMonth;
    if (active >= target) return m;
  }
  return null;
}

function scenarios(config) {
  const { targetMonthlyINR: target, growthPlanINR: growth, enterpriseDealINR: ent, assumedRepeatRate: repeat } = config.revenue;

  const mixes = [
    { name: 'All Growth plan', growth: Math.ceil(target / growth), enterprise: 0 },
    { name: '1 Enterprise + Growth', growth: Math.max(0, Math.ceil((target - ent) / growth)), enterprise: 1 },
    { name: '2 Enterprise + Growth', growth: Math.max(0, Math.ceil((target - 2 * ent) / growth)), enterprise: 2 },
  ];

  return mixes.map((m) => {
    const revenue = m.growth * growth + m.enterprise * ent;
    const activeClients = m.growth + m.enterprise;
    return {
      ...m,
      revenue,
      activeClients,
      replacePerMonth: Math.ceil(steadyState(activeClients, repeat)),
    };
  });
}

/**
 * Funnel maths, per lane. Warm and cold convert very differently, and averaging
 * them hides the entire reason the warm lane exists.
 */
const FUNNEL = {
  warm: { reply: 0.30, trial: 0.40, paid: 0.25, label: 'warm (1st-degree)' },
  cold: { reply: 0.12, trial: 0.40, paid: 0.25, label: 'cold' },
};

function accountsNeeded(newClientsPerMonth, lane) {
  const f = FUNNEL[lane];
  const trials = newClientsPerMonth / f.paid;
  const replies = trials / f.trial;
  const sends = replies / f.reply;
  return { sends: Math.ceil(sends), replies: Math.ceil(replies), trials: Math.ceil(trials), ...f };
}

// ---------------------------------------------------------------------------

function report(config) {
  const R = config.revenue;
  const fmt = (n) => '₹' + n.toLocaleString('en-IN');

  console.log('\n═══ Revenue map — target ' + fmt(R.targetMonthlyINR) + '/month ═══\n');

  console.log('Plans: Growth ' + fmt(R.growthPlanINR) + ' / 30 days · Enterprise ~' + fmt(R.enterpriseDealINR) + ' (assumed)');
  console.log('Note:  plans are one-time 30-day purchases with no auto-renewal, so this');
  console.log('       revenue is re-won monthly. Repeat rate assumed ' + Math.round(R.assumedRepeatRate * 100) + '%.\n');

  console.log('── Mixes that reach the target ──');
  console.log('  scenario                  clients   revenue      replace/mo');
  for (const s of scenarios(config)) {
    console.log(
      `  ${s.name.padEnd(24)}  ${String(s.activeClients).padStart(5)}   ${fmt(s.revenue).padStart(10)}   ${String(s.replacePerMonth).padStart(6)}`
    );
  }

  const chosen = scenarios(config)[1]; // 1 Enterprise + Growth — the realistic middle
  console.log(`\n── Working backwards from "${chosen.name}" ──`);
  console.log(`  ${chosen.activeClients} active clients (${chosen.enterprise} enterprise + ${chosen.growth} growth) = ${fmt(chosen.revenue)}`);
  console.log(`  At ${Math.round(R.assumedRepeatRate * 100)}% repeat, ${chosen.replacePerMonth} must be replaced every month just to hold it.`);

  const build = 4;
  const months = rampMonths(chosen.activeClients, build, R.assumedRepeatRate);
  console.log(`  Acquiring ${build} new clients/month reaches ${chosen.activeClients} active in ~${months} months.\n`);

  console.log('── What that needs at the top of the funnel, per month ──');
  for (const lane of ['warm', 'cold']) {
    const n = accountsNeeded(build, lane);
    console.log(`  ${n.label.padEnd(20)} ${String(n.sends).padStart(4)} sends → ${String(n.replies).padStart(3)} replies → ${String(n.trials).padStart(2)} trials → ${build} paid`);
  }
  const warm = accountsNeeded(build, 'warm');
  console.log(`\n  Warm lane needs ~${Math.ceil(warm.sends / 22)} sends a working day — comfortably inside the ${config.outreach.dailySendCeiling}/day ceiling.`);
  const cold = accountsNeeded(build, 'cold');
  console.log(`  Cold-only would need ~${Math.ceil(cold.sends / 22)}/day, which is over the ceiling AND over the safe scraping rate.`);
  console.log('  That gap is the entire argument for working the warm network first.\n');

  // --- against the actual pipeline -----------------------------------------
  let db;
  try { db = DB.open(); } catch { return; }

  const bands = db.prepare("SELECT band, COUNT(*) n FROM accounts GROUP BY band").all()
    .reduce((a, r) => ({ ...a, [r.band]: r.n }), {});
  const drafts = db.prepare("SELECT status, COUNT(*) n FROM drafts GROUP BY status").all()
    .reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
  const sent = db.prepare("SELECT COUNT(*) n FROM drafts WHERE sent_by_human_at IS NOT NULL").get().n;

  const workable = (bands.A || 0) + (bands.B || 0);

  console.log('── Where the pipeline actually is ──');
  console.log(`  Band A ${bands.A || 0} · Band B ${bands.B || 0} · Band C ${bands.C || 0}`);
  console.log(`  Drafts ready ${drafts.DRAFT || 0} · withheld ${drafts.WITHHELD || 0} · sent by you ${sent}`);

  const needed = warm.sends;
  if (workable >= needed) {
    console.log(`\n  ✔ ${workable} workable accounts vs ~${needed} sends needed this month. Enough to work.`);
  } else {
    const gap = needed - workable;
    console.log(`\n  → ${workable} workable accounts, ~${needed} sends needed this month. Gap: ${gap}.`);
    console.log(`    Close it by enriching more companies (npm run enrich) — every company`);
    console.log(`    with verified openings can move from Band C into A or B.`);
  }
  console.log('');
}

module.exports = { report, scenarios, accountsNeeded, steadyState, rampMonths, FUNNEL };
