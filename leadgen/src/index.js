#!/usr/bin/env node
/**
 * index.js — the run.
 *
 *   node src/index.js --profile=default
 *   node src/index.js --profile=client-acme --dry-run   (skip Sheets, write local files)
 *   node src/index.js --no-careers                      (skip careers validation)
 *   node src/index.js --force                           (override the pacing governor)
 *
 * Flow: governor check → launch persistent profile → confirm login → for each
 * search: harvest cards → pre-score → visit only the promising profiles →
 * validate hiring on the company site → final score → drafts → Sheets.
 *
 * The run aborts the moment anything looks like a block. Pushing through a
 * soft warning is how a healthy account becomes a restricted one.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const H = require('./humanize');
const S = require('./session');
const Scrape = require('./scrape');
const { validateHiring } = require('./careers');
const { scoreLead } = require('./score');
const { buildDrafts, assertDraftOnly } = require('./messages');

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const PROFILE = arg('profile', 'default');
const DRY_RUN = flag('dry-run');
const FORCE = flag('force');
if (flag('no-careers')) config.careersValidation.enabled = false;

const OUT_DIR = path.resolve(__dirname, '..', 'output');

// ---------------------------------------------------------------------------

function saveLocal(name, data) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, `${name}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/**
 * Cheap pre-score from the search card alone, so profile visits — the scarcest
 * resource in the whole run — are spent only on plausible leads.
 */
function preScore(card, config) {
  const t = (card.headline || '').toLowerCase();
  const tier1 = new RegExp(config.scoring.tier1TitleRegex, 'i');
  const tier2 = new RegExp(config.scoring.tier2TitleRegex, 'i');
  if (tier1.test(t)) return 3;
  if (tier2.test(t)) return 2;
  if (/\b(hr|human resource|people|talent|recruit|hiring|staffing)\b/.test(t)) return 1;
  return 0;
}

// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  assertDraftOnly(config); // fails fast if anyone ever flips this

  console.log('\n═══ MinMaxHR LinkedIn Lead Engine ═══');
  console.log(`Profile: ${PROFILE}${DRY_RUN ? '  (dry run — no Sheets write)' : ''}`);
  console.log('Mode: DRAFT ONLY. This tool never sends a message.\n');

  // --- Governor -------------------------------------------------------------
  const gate = S.checkGovernor(config);
  if (!gate.ok) {
    if (!FORCE) {
      console.log(`⛔ Run blocked by the pacing governor: ${gate.reason}`);
      console.log('   This exists to protect the account. Re-run later, or pass --force if you accept the risk.');
      process.exit(0);
    }
    console.log(`⚠ Governor says: ${gate.reason} — overridden with --force.`);
  }

  const budget = Math.min(config.limits.maxProfileVisitsPerRun, S.remainingProfileBudget(config) || 999);
  const persona = H.newPersona();
  console.log(`Persona this run: ${persona.name} (speed ×${persona.speed}, dwell ×${persona.dwell})`);
  console.log(`Profile-visit budget: ${budget}\n`);

  const { context } = await S.launchSession(config, PROFILE);
  const page = await context.newPage();

  // Separate cookie-less context for company websites.
  const { chromium } = require('playwright');
  const webBrowser = await chromium.launch({ headless: false });
  const webPage = await (await webBrowser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();

  const allLeads = [];
  let cardsSeen = 0;
  let profilesVisited = 0;
  let outcome = 'completed';

  try {
    await S.ensureLoggedIn(page, persona);
    await H.dwell(persona, config.pacing.pageDwellMs);

    // Rotate which search runs first so the account's daily pattern differs.
    const searches = H.shuffle(config.searches);

    for (const search of searches) {
      if (allLeads.length >= config.targetLeadCount) break;
      if (profilesVisited >= budget) break;

      await Scrape.runSearch(page, persona, config, search.keywords);

      // ---- harvest -------------------------------------------------------
      let cards = [];
      const pagesToRead = H.randInt(1, config.limits.maxSearchPagesPerRun);
      for (let p = 0; p < pagesToRead; p++) {
        const pageCards = await Scrape.harvestResultsPage(page, persona, config);
        cards.push(...pageCards);
        console.log(`   page ${p + 1}: ${pageCards.length} cards`);
        if (p < pagesToRead - 1) {
          if (!(await Scrape.goToNextPage(page, persona, config))) break;
        }
      }

      // Dedupe against what this run already has.
      const seen = new Set(allLeads.map((l) => l.url));
      cards = cards.filter((c) => c.url && !seen.has(c.url));
      cardsSeen += cards.length;

      // ---- choose who is worth a profile visit ----------------------------
      const ranked = cards
        .map((c) => ({ ...c, pre: preScore(c, config) }))
        .filter((c) => c.pre > 0)
        .sort((a, b) => b.pre - a.pre);

      // Not strictly by rank — a person does not visit in perfect score order.
      const toVisit = H.humanOrder(ranked, { skipRate: 0.15 })
        .slice(0, Math.max(0, Math.min(budget - profilesVisited, config.limits.maxProfilesPerRun)));

      console.log(`   ${cards.length} new cards → ${toVisit.length} worth visiting`);

      let sinceBreak = 0;
      const breakEvery = H.randInt(...config.pacing.longBreakEveryNProfiles);

      for (const card of toVisit) {
        if (allLeads.length >= config.targetLeadCount) break;
        if (profilesVisited >= budget) break;

        // Sometimes a person opens a result, changes their mind, and backs out.
        if (H.chance(config.pacing.abandonRate)) {
          console.log(`   ↩ skipping ${card.name} (changed mind)`);
          await H.pause(persona, config.pacing.actionDelayMs);
          continue;
        }

        let lead;
        try {
          lead = await Scrape.visitProfile(page, persona, config, card);
          profilesVisited += 1;
          sinceBreak += 1;
        } catch (e) {
          if (/BLOCKED/.test(e.message)) throw e;
          console.log(`   ! could not read ${card.name}: ${e.message}`);
          continue;
        }

        lead.searchSource = search.label;

        // ---- validate hiring on the company's own site --------------------
        let validation = { openings: 0, atsDetected: false, careersUrl: '', website: '', hiringSignal: 'unknown', validationNote: 'skipped' };
        if (config.careersValidation.enabled && lead.company) {
          try {
            validation = await validateHiring(page, webPage, lead, config, persona);
          } catch (e) {
            validation.validationNote = `validation failed: ${e.message}`;
          }
        }
        Object.assign(lead, validation);

        // ---- score ---------------------------------------------------------
        Object.assign(lead, scoreLead(lead, config));
        allLeads.push(lead);

        console.log(`   ✔ ${lead.score.toString().padStart(3)} │ ${lead.band.padEnd(20)} │ ${(lead.name || '').slice(0, 26).padEnd(26)} │ ${(lead.company || '—').slice(0, 24)}`);

        await H.pause(persona, config.pacing.actionDelayMs);

        if (sinceBreak >= breakEvery) {
          sinceBreak = 0;
          await H.longBreak(persona, config.pacing.longBreakMs);
          if (H.chance(0.5)) await S.organicDetour(page, persona);
        }
      }

      // Pause between searches — nobody fires four searches back to back.
      if (allLeads.length < config.targetLeadCount) {
        await H.longBreak(persona, config.pacing.longBreakMs);
      }
    }
  } catch (e) {
    outcome = e.message;
    if (/BLOCKED/.test(e.message)) {
      console.log(`\n⛔ ${e.message}`);
      console.log('   Stopping immediately and keeping what was collected.');
      console.log('   Do not re-run this profile today. Open LinkedIn manually, browse normally for a day, then resume tomorrow.');
    } else {
      console.log(`\n! Run error: ${e.message}`);
    }
  } finally {
    await context.close().catch(() => {});
    await webBrowser.close().catch(() => {});
  }

  // --- Output ---------------------------------------------------------------
  allLeads.sort((a, b) => b.score - a.score);
  const drafts = buildDrafts(allLeads, config);

  const bandA = allLeads.filter((l) => l.score >= 90).length;
  const bandB = allLeads.filter((l) => l.score >= config.scoring.priorityThreshold && l.score < 90).length;
  const durationMin = Math.round((Date.now() - startedAt) / 60000);

  console.log('\n─── Summary ───');
  console.log(`Cards seen:       ${cardsSeen}`);
  console.log(`Profiles visited: ${profilesVisited}`);
  console.log(`Leads scored:     ${allLeads.length}`);
  console.log(`Band A (90+):     ${bandA}`);
  console.log(`Band B (75–89):   ${bandB}`);
  console.log(`Drafts written:   ${drafts.filter((d) => d.status.startsWith('DRAFT')).length} (withheld: ${drafts.filter((d) => d.status === 'WITHHELD').length})`);
  console.log(`Duration:         ${durationMin} min`);

  console.log(`\nLocal copy: ${saveLocal('leads', allLeads)}`);
  console.log(`Local copy: ${saveLocal('drafts', drafts)}`);

  if (!DRY_RUN && config.sheets.spreadsheetId !== 'CHANGE_ME') {
    try {
      const Sheets = require('./sheets');
      const r1 = await Sheets.writeLeads(config, allLeads);
      const r2 = await Sheets.writeDrafts(config, drafts);
      await Sheets.writeRunLog(config, {
        persona: persona.name, searches: config.searches.length, cardsSeen,
        profilesVisited, leadsScored: allLeads.length, bandA, bandB,
        draftsWritten: drafts.length, durationMin, outcome,
      });
      console.log(`\n✔ Sheets: ${r1.appended} new leads, ${r1.updated} updated, ${r2.appended} drafts.`);
    } catch (e) {
      console.log(`\n! Sheets write failed: ${e.message}`);
      console.log('  The local JSON above has everything — nothing was lost.');
    }
  } else {
    console.log('\n(Sheets write skipped — dry run or spreadsheetId not set.)');
  }

  S.recordRun(config, { profilesViewed: profilesVisited });

  console.log('\nDrafts are DRAFTS. Read each one, then send it yourself from LinkedIn.');
  console.log('Suggested cadence: no more than 15–20 sends a day, spread across the working day.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
