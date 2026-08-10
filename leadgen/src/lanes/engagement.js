/**
 * lanes/engagement.js — Lane B. The warmest leads you have.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 * The scoring machinery for post engagement was already fully built and
 * completely unused:
 *
 *   venn.js      grants +15 Access (`accessEngagedBonus`) and +12 Timing
 *                for a `post_engagement` signal
 *   playbook.js  carries a dedicated `engaged` angle for all four segments
 *                — "thanks for engaging with the post"
 *   signals.js   never populated the signal, and said so in its header
 *
 * So until now, someone who publicly reacted to your content — who raised their
 * hand — scored exactly the same as a stranger, and four hand-written sales
 * angles were unreachable. This lane populates the signal; everything
 * downstream then works with no other change.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Risk profile: low. Reading the reactions on your own posts is ordinary account
 * use, not search. It still respects the governor and every stop condition,
 * because "low risk" and "no risk" are different things.
 */

const { sleep, humanDelay, humanScroll, humanClick, pause, chance } = require('../humanize');
const { detectBlock } = require('../session');
const { upsertCompany, upsertPerson, addSignal } = require('../db');
const { classifySeniority } = require('../score');
const { segmentOf, regionOf } = require('../venn');

/** Finds your recent posts from the activity feed. */
async function findRecentPosts(page, profileUrl, persona, limit = 5) {
  const url = profileUrl.replace(/\/$/, '') + '/recent-activity/all/';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(humanDelay(2500, 5000));
  await humanScroll(page, persona, { depth: 'partial' });

  return page.evaluate((max) => {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll('[data-urn], [data-id]')) {
      const urn = el.getAttribute('data-urn') || el.getAttribute('data-id') || '';
      if (!/activity[:(]/.test(urn) || seen.has(urn)) continue;
      seen.add(urn);
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const reactions = parseInt((text.match(/([\d,]+)\s*(reaction|like)/i) || [0, '0'])[1].replace(/,/g, ''), 10) || 0;
      out.push({ urn, reactions, snippet: text.slice(0, 100) });
      if (out.length >= max) break;
    }
    return out;
  }, limit);
}

/**
 * Opens the reactions list for one post and reads who is in it.
 *
 * LinkedIn renders reactors in a modal behind the "N reactions" button. There
 * is no stable API surface here, so this clicks the real control and reads the
 * real list — which is also what a person catching up on their post does.
 */
async function readReactors(page, persona, config) {
  const trigger = page.locator(
    'button[aria-label*="reaction" i], button[data-reaction-details], .social-details-social-counts__reactions'
  ).first();

  if (!(await trigger.isVisible({ timeout: 5000 }).catch(() => false))) return [];

  await humanClick(page, trigger, persona);
  await sleep(humanDelay(2000, 4000));

  const modal = page.locator('[role="dialog"], .artdeco-modal').first();
  if (!(await modal.isVisible({ timeout: 6000 }).catch(() => false))) return [];

  // Scroll the modal a few times so the lazy list fills in.
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 400 + Math.random() * 300);
    await sleep(humanDelay(500, 1400));
  }

  const people = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const dialog = document.querySelector('[role="dialog"], .artdeco-modal');
    if (!dialog) return [];

    const out = [];
    for (const link of dialog.querySelectorAll('a[href*="/in/"]')) {
      const href = link.href.split('?')[0].replace(/\/$/, '');
      if (!/\/in\/[^/]+$/.test(href)) continue;

      const card = link.closest('li') || link.parentElement?.parentElement;
      const lines = (card ? card.innerText : link.innerText)
        .split('\n').map(clean).filter(Boolean)
        .filter((l) => !/^(status is|·|Connect|Follow|Message|\d+(st|nd|rd)\+? degree)/i.test(l));

      const name = clean((link.innerText || '').split('\n')[0]) || lines[0] || '';
      if (!name || name.length > 80) continue;

      const rest = lines.filter((l) => l !== name);
      // Degree badge: "1st", "2nd", "3rd+"
      const degreeText = (card ? card.innerText : '').match(/\b(1st|2nd|3rd)\b/);
      const degree = degreeText ? { '1st': 1, '2nd': 2, '3rd': 3 }[degreeText[1]] : 3;

      out.push({ url: href, name, headline: rest[0] || '', degree });
    }

    // Dedupe by profile url.
    const seen = new Map();
    for (const p of out) if (!seen.has(p.url)) seen.set(p.url, p);
    return Array.from(seen.values());
  });

  // Close the modal like a person would.
  const close = page.locator('[role="dialog"] button[aria-label*="Dismiss" i], [role="dialog"] button[aria-label*="Close" i]').first();
  if (await close.isVisible({ timeout: 3000 }).catch(() => false)) {
    await humanClick(page, close, persona).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await sleep(humanDelay(1000, 2500));

  return people;
}

/** Pulls the company out of a headline like "CHRO at Acme Industries". */
function companyFromHeadline(headline) {
  const m = (headline || '').match(/\bat\s+(.+?)(\s*[|·]|$)/i);
  return m ? m[1].replace(/\s*·.*$/, '').trim() : '';
}

/**
 * Harvests engagement from your recent posts into the pipeline.
 *
 * Only ICP-relevant engagers are stored. Someone who liked your post but works
 * in an unrelated field is not a lead, and adding them would dilute the very
 * scoreboard this lane exists to sharpen.
 */
async function harvestEngagement(db, page, config, persona, profileUrl, { maxPosts = 5 } = {}) {
  const stats = { posts: 0, engagers: 0, icp: 0, companies: 0, signals: 0, skipped: 0 };

  const posts = await findRecentPosts(page, profileUrl, persona, maxPosts);
  if (!posts.length) {
    stats.note = 'no recent posts found — nothing to harvest. Post twice a week and this lane starts producing.';
    return stats;
  }

  const companyIds = new Set();

  for (const post of posts) {
    if (post.reactions === 0) continue;

    const postUrl = `https://www.linkedin.com/feed/update/${post.urn.replace(/^urn:li:/, 'urn:li:')}/`;
    try {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      await sleep(humanDelay(2500, 5000));

      const blocked = await detectBlock(page);
      if (blocked) throw new Error(`BLOCKED: ${blocked}`);

      await humanScroll(page, persona, { depth: 'partial' });

      const reactors = await readReactors(page, persona, config);
      stats.posts++;
      stats.engagers += reactors.length;

      for (const r of reactors) {
        const tier = classifySeniority(r.headline, config);
        if (tier !== 'tier1' && tier !== 'tier2') { stats.skipped++; continue; }

        const companyName = companyFromHeadline(r.headline);
        if (!companyName) { stats.skipped++; continue; }

        const companyId = upsertCompany(db, {
          name: companyName,
          segment: segmentOf({ name: companyName }),
        });
        if (!companyId) { stats.skipped++; continue; }
        companyIds.add(companyId);

        const personId = upsertPerson(db, {
          linkedin_url: r.url,
          company_id: companyId,
          name: r.name,
          title: r.headline,
          seniority_tier: tier,
          degree: r.degree,
          source_lane: 'engagement',
        });

        // The signal that was dead code until now.
        addSignal(db, {
          entity_type: 'person', entity_id: personId, kind: 'post_engagement',
          detail: `reacted to: ${post.snippet}`.slice(0, 200),
          source: postUrl,
        });

        stats.icp++;
        stats.signals++;
      }

      await pause(persona, config.pacing.actionDelayMs);
    } catch (e) {
      if (/BLOCKED/.test(e.message)) throw e;
      // A single unreadable post should not end the lane.
    }
  }

  stats.companies = companyIds.size;
  return stats;
}

module.exports = { harvestEngagement, findRecentPosts, readReactors, companyFromHeadline };
