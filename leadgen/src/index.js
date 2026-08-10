#!/usr/bin/env node
/**
 * index.js — the run.
 *
 *   node src/index.js warm            import Connections.csv (no browser, no risk)
 *   node src/index.js enrich          enrich companies from their own websites
 *   node src/index.js score           re-score every account through the Venn
 *   node src/index.js draft           build drafts + schedule touch sequences
 *   node src/index.js cold            cold LinkedIn search (the risky lane, last)
 *   node src/index.js sync            render the DB to Google Sheets
 *   node src/index.js daily           warm → enrich → score → draft → sync
 *
 * Flags: --profile=<name> --dry-run --force --limit=<n>
 *
 * The lanes are separate commands on purpose. Only `cold` touches LinkedIn
 * search; `warm` needs no browser at all; `enrich` uses a clean context against
 * public company websites. Splitting them means the highest-value work carries
 * no account risk and can run as often as you like.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const H = require('./humanize');
const S = require('./session');
const DB = require('./db');
const Scrape = require('./scrape');
const Venn = require('./venn');
const Signals = require('./signals');
const Sequence = require('./sequence');
const { importConnections } = require('./lanes/warm');
const { enrichCompany } = require('./enrich/company');
const { classifySeniority, preScore } = require('./score');
const { buildDraft, assertDraftOnly } = require('./messages');

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('--')) || 'daily';
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const PROFILE = arg('profile', 'default');
const DRY_RUN = flag('dry-run');
const FORCE = flag('force');
const LIMIT = Number(arg('limit', 0)) || null;

const CHROMIUM = process.env.CHROMIUM_PATH || undefined;

// ---------------------------------------------------------------------------
// Lane A — warm network. No browser. No risk.
// ---------------------------------------------------------------------------

function laneWarm(db) {
  console.log('\n▸ Lane A — warm network');
  const csv = config.lanes.warm.connectionsCsv;
  const stats = importConnections(db, config, csv);

  if (!stats.ok) {
    console.log(`   ${stats.reason}`);
    if (stats.howTo) console.log(`   → ${stats.howTo}`);
    return stats;
  }

  const recency = Signals.deriveConnectionRecency(db, config);
  console.log(`   ${stats.rows} rows → ${stats.people} people at ${stats.companies} companies`);
  console.log(`   ICP contacts: ${stats.icp} (tier1 ${stats.tier1}, tier2 ${stats.tier2})`);
  console.log(`   Segments: ${Object.entries(stats.bySegment).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`   ${recency} connected within 90 days (warm opener available)`);
  if (stats.skippedNoCompany) console.log(`   ${stats.skippedNoCompany} skipped — no company on the row`);
  return stats;
}

// ---------------------------------------------------------------------------
// Enrichment — public websites only, no LinkedIn
// ---------------------------------------------------------------------------

async function laneEnrich(db) {
  console.log('\n▸ Enrichment — company websites (no LinkedIn traffic)');
  const { chromium } = require('playwright');
  const persona = H.newPersona();

  const targets = DB.companiesNeedingEnrichment(db, {
    limit: LIMIT || config.careersValidation.maxCompaniesPerRun,
  });

  if (!targets.length) {
    console.log('   Nothing due — every company was checked recently.');
    return 0;
  }
  console.log(`   ${targets.length} companies due (most-contacts first)`);

  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.setDefaultTimeout(config.careersValidation.timeoutMs);

  let done = 0;
  try {
    for (const c of targets) {
      try {
        const r = await enrichCompany(db, page, c, config, persona);
        console.log(`   ${r.changed ? '✔' : '·'} ${c.name.slice(0, 34).padEnd(34)} ${r.note}`);
        done++;
      } catch (e) {
        console.log(`   ! ${c.name}: ${e.message.split('\n')[0]}`);
      }
      await H.pause(persona, config.pacing.actionDelayMs);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return done;
}

// ---------------------------------------------------------------------------
// Scoring — the Venn
// ---------------------------------------------------------------------------

function laneScore(db) {
  console.log('\n▸ Scoring — Fit × Access × Timing');
  const companies = DB.allCompanies(db);
  let a = 0, b = 0, c = 0;

  for (const company of companies) {
    const people = DB.peopleForCompany(db, company.id);
    const signals = Signals.signalsForCompany(db, company.id);
    const perPerson = Signals.personSignalMap(db, company.id);

    const scored = Venn.scoreAccount(company, people, signals, config, perPerson);
    DB.saveAccount(db, company.id, scored);

    // Blockers discovered during scoring belong on the company record.
    if (scored.blockers.length) {
      DB.upsertCompany(db, { name: company.name, blockers: scored.blockers });
    }

    if (scored.band === 'A') a++; else if (scored.band === 'B') b++; else c++;
  }

  console.log(`   ${companies.length} accounts scored → A ${a} · B ${b} · C ${c}`);

  const top = DB.topAccounts(db, 10);
  if (top.length) {
    console.log('\n   Top accounts:');
    for (const t of top) {
      console.log(`   ${String(t.priority).padStart(3)} [${t.band}] ${(t.name || '').slice(0, 30).padEnd(30)} ` +
                  `fit ${String(t.fit).padStart(3)} · access ${String(t.access).padStart(3)} · timing ${String(t.timing).padStart(3)}`);
    }
  }
  return { a, b, c };
}

// ---------------------------------------------------------------------------
// Drafts + touch sequences
// ---------------------------------------------------------------------------

function laneDraft(db) {
  assertDraftOnly(config);
  console.log('\n▸ Drafting — DRAFTS ONLY, nothing is sent');

  const accounts = db.prepare(`
    SELECT a.*, c.* FROM accounts a JOIN companies c ON c.id = a.company_id
    WHERE a.band IN ('A','B') ORDER BY a.priority DESC LIMIT ?
  `).all(LIMIT || config.outreach.topNForMessages);

  let drafted = 0, withheld = 0;

  for (const row of accounts) {
    const company = { ...row, id: row.company_id, name: row.name };
    const people = DB.peopleForCompany(db, company.id);

    // One contact per company. Messaging three people at the same firm in the
    // same week reads as a blast, not as outreach — and it burns the account.
    const target = people.find((p) => p.seniority_tier === 'tier1')
                || people.find((p) => p.seniority_tier === 'tier2');
    if (!target) continue;

    const signals = Signals.signalsForCompany(db, company.id);
    const d = buildDraft({ company, person: target, signals }, config);

    DB.saveDraft(db, target.id, {
      angle: d.angle,
      body: d.body,
      status: d.ok ? 'DRAFT' : 'WITHHELD',
      note: d.reason,
    });

    if (d.ok) {
      Sequence.scheduleSequence(db, target.id);
      drafted++;
    } else {
      withheld++;
    }
  }

  const { actions, messagesQueued, ceiling } = Sequence.dueToday(db, config);
  console.log(`   ${drafted} drafted · ${withheld} withheld (unverifiable variables)`);
  console.log(`   ${actions.length} actions due today · ${messagesQueued}/${ceiling} messages queued`);
  return { drafted, withheld, actions: actions.length };
}

// ---------------------------------------------------------------------------
// Lane C — cold search. The risky one. Smallest budget, runs last.
// ---------------------------------------------------------------------------

async function laneCold(db) {
  console.log('\n▸ Lane C — cold LinkedIn search');

  const gate = S.checkGovernor(config);
  if (!gate.ok && !FORCE) {
    console.log(`   ⛔ Governor: ${gate.reason}`);
    console.log('   Warm and enrich lanes are unaffected — they do not touch LinkedIn.');
    return { profiles: 0, outcome: `governor: ${gate.reason}` };
  }
  if (!gate.ok) console.log(`   ⚠ Governor: ${gate.reason} — overridden with --force`);

  const budget = Math.min(
    config.lanes.cold.profileBudget,
    S.remainingProfileBudget(config) || 0
  );
  if (budget <= 0) {
    console.log('   Daily profile budget exhausted.');
    return { profiles: 0, outcome: 'budget exhausted' };
  }

  const persona = H.newPersona();
  console.log(`   Persona: ${persona.name} · budget ${budget} profiles`);

  const { context } = await S.launchSession(config, PROFILE);
  const page = await context.newPage();

  let profiles = 0, outcome = 'completed';
  try {
    await S.ensureLoggedIn(page, persona);

    const tier = await S.detectAccountTier(page);
    console.log(`   Account tier detected: ${tier}`);

    for (const search of H.shuffle(config.searches)) {
      if (profiles >= budget) break;

      await Scrape.runSearch(page, persona, config, search.keywords);

      if (await S.detectCommercialLimit(page)) {
        // A quota, not a warning. Stop searching, keep everything else.
        console.log('   ⚠ Commercial Use Limit reached — search is capped until the 1st.');
        console.log('     Not a restriction. Work the warm lane; it does not consume this quota.');
        outcome = 'commercial use limit';
        break;
      }

      const cards = await Scrape.harvestResultsPage(page, persona, config);
      const worth = cards
        .map((c) => ({ ...c, pre: preScore(c.headline, config) }))
        .filter((c) => c.pre > 0)
        .sort((a, b) => b.pre - a.pre);

      console.log(`   "${search.label}": ${cards.length} cards → ${worth.length} worth visiting`);

      for (const card of H.humanOrder(worth, { skipRate: 0.15 })) {
        if (profiles >= budget) break;
        if (H.chance(config.pacing.abandonRate)) continue;

        let lead;
        try {
          lead = await Scrape.visitProfile(page, persona, config, card);
          profiles++;
        } catch (e) {
          if (/BLOCKED/.test(e.message)) throw e;
          continue;
        }

        if (!lead.company) continue;

        const companyId = DB.upsertCompany(db, {
          name: lead.company,
          linkedin_url: lead.companyLinkedIn || null,
          segment: Venn.segmentOf({ name: lead.company }),
          region: Venn.regionOf(lead.location, config),
        });
        if (!companyId) continue;

        DB.upsertPerson(db, {
          linkedin_url: lead.url,
          company_id: companyId,
          name: lead.name,
          title: lead.title,
          seniority_tier: classifySeniority(lead.title, config),
          location: lead.location,
          degree: 3,
          source_lane: 'cold',
          profile_checked_at: new Date().toISOString(),
        });

        console.log(`   ✔ ${(lead.name || '').slice(0, 24).padEnd(24)} │ ${(lead.company || '').slice(0, 26)}`);
        await H.pause(persona, config.pacing.actionDelayMs);
      }

      if (profiles < budget) await H.longBreak(persona, config.pacing.longBreakMs);
    }
  } catch (e) {
    outcome = e.message;
    if (/BLOCKED/.test(e.message)) {
      console.log(`\n   ⛔ ${e.message}`);
      console.log('   Stopping. Do not re-run this profile today — see SOP §3.4.');
    } else {
      console.log(`\n   ! ${e.message}`);
    }
  } finally {
    await context.close().catch(() => {});
    S.recordRun(config, { profilesViewed: profiles });
  }

  return { profiles, outcome };
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

async function laneSync(db) {
  if (DRY_RUN) { console.log('\n(sync skipped — dry run)'); return; }
  console.log('\n▸ Sync — rendering to Google Sheets');
  try {
    const R = require('./render/sheets');
    const out = await R.renderAll(db, config);
    console.log(`   Accounts ${out.accounts} · Companies ${out.companies} · People ${out.people} · ` +
                `Drafts ${out.drafts} · Actions ${out.actions}`);
  } catch (e) {
    console.log(`   ! Sheets write failed: ${e.message.split('\n')[0]}`);
    console.log(`   Nothing lost — the pipeline lives in ${DB.DB_PATH}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  assertDraftOnly(config);

  console.log('\n═══ MinMaxHR Revenue Engine ═══');
  console.log(`Command: ${command} · profile: ${PROFILE}${DRY_RUN ? ' · dry run' : ''}`);
  console.log('Mode: DRAFT ONLY — this tool never sends a message.');

  const db = DB.open();
  let profiles = 0, bands = { a: 0, b: 0, c: 0 }, drafts = { drafted: 0 }, outcome = 'completed';

  switch (command) {
    case 'warm':   laneWarm(db); break;
    case 'enrich': await laneEnrich(db); break;
    case 'score':  bands = laneScore(db); break;
    case 'draft':  drafts = laneDraft(db); break;
    case 'cold':   ({ profiles, outcome } = await laneCold(db)); break;
    case 'sync':   await laneSync(db); break;

    case 'daily':
      // Warm first, always. It is free, it is safe, and it is where the
      // revenue is. Cold search is a separate command precisely so it is a
      // deliberate choice rather than something that happens by default.
      laneWarm(db);
      await laneEnrich(db);
      bands = laneScore(db);
      drafts = laneDraft(db);
      await laneSync(db);
      break;

    default:
      console.log(`\nUnknown command "${command}". Try: warm | enrich | score | draft | cold | sync | daily`);
      process.exit(1);
  }

  const durationMin = Math.round((Date.now() - started) / 60000);

  if (!DRY_RUN && ['daily', 'cold', 'score'].includes(command)) {
    try {
      await require('./render/sheets').appendRunLog(config, {
        lane: command, persona: '-', profilesSeen: profiles,
        companiesTouched: DB.allCompanies(db).length,
        accountsScored: bands.a + bands.b + bands.c,
        bandA: bands.a, bandB: bands.b, drafts: drafts.drafted,
        durationMin, outcome,
      });
    } catch { /* run log is nice to have, not worth failing the run */ }
  }

  console.log(`\nDone in ${durationMin} min. Pipeline: ${DB.DB_PATH}`);
  if (['daily', 'draft'].includes(command)) {
    console.log('Open the "Daily Actions" tab. Do the steps yourself — nothing was sent.');
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
