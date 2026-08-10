/**
 * scrape.js — search + profile extraction.
 *
 * Two behavioural choices matter here:
 *
 * 1. Search is driven through the real search box (click, type, Enter) rather
 *    than by navigating straight to /search/results/people/?keywords=…
 *    Deep-linking into a results URL with no referring interaction is a
 *    navigation pattern normal users almost never produce.
 *
 * 2. Selectors are deliberately defensive. LinkedIn's class names are hashed
 *    and rotate; anything anchored to a single `.artdeco-x9f2` will break
 *    within weeks. Extraction works off stable structure (links to /in/,
 *    heading order) with several fallbacks, and reports honestly when the DOM
 *    has moved rather than silently returning empty rows.
 */

const {
  humanDelay, sleep, humanScroll, humanClick, humanType, scrollToElement,
  pause, dwell, chance, randInt, humanOrder,
} = require('./humanize');
const { detectBlock } = require('./session');

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function runSearch(page, persona, config, keywords) {
  console.log(`\n▸ Searching: "${keywords}"`);

  // Start from the home feed, like a person who just opened LinkedIn.
  if (!page.url().includes('linkedin.com/feed')) {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
    await sleep(humanDelay(2000, 4500));
    await humanScroll(page, persona, { depth: 'partial' });
  }

  const searchBox = page.locator(
    'input.search-global-typeahead__input, input[placeholder*="Search" i], #global-nav-search input'
  ).first();

  let usedBox = false;
  try {
    // The box is sometimes collapsed behind a button on narrow viewports.
    if (!(await searchBox.isVisible({ timeout: 4000 }).catch(() => false))) {
      const trigger = page.locator('#global-nav-search button, button[aria-label*="Search" i]').first();
      if (await trigger.isVisible({ timeout: 3000 }).catch(() => false)) {
        await humanClick(page, trigger, persona);
        await sleep(humanDelay(600, 1500));
      }
    }
    await humanType(page, searchBox, keywords, persona, config.pacing.typingDelayMs);
    await sleep(humanDelay(500, 1600));
    await page.keyboard.press('Enter');
    usedBox = true;
  } catch {
    console.log('   (search box unavailable — falling back to direct URL)');
  }

  if (!usedBox) {
    await page.goto(
      `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`,
      { waitUntil: 'domcontentloaded' }
    );
  }

  await page.waitForLoadState('domcontentloaded');
  await sleep(humanDelay(2500, 5000));

  // Make sure we are on the People tab.
  if (!page.url().includes('/search/results/people')) {
    const peopleTab = page.locator('button:has-text("People"), a:has-text("People")').first();
    if (await peopleTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await humanClick(page, peopleTab, persona);
      await sleep(humanDelay(2500, 5000));
    }
  }

  const block = await detectBlock(page);
  if (block) throw new Error(`BLOCKED: ${block}`);

  return true;
}

// ---------------------------------------------------------------------------
// Result extraction
// ---------------------------------------------------------------------------

/**
 * Pulls the visible result cards. Runs entirely in page context off structural
 * anchors: every result card contains exactly one /in/ profile link, and the
 * card's text lines are name → headline → location in DOM order.
 */
async function extractResultCards(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const links = Array.from(document.querySelectorAll('a[href*="/in/"]'));
    const byProfile = new Map();

    for (const link of links) {
      const href = link.href.split('?')[0].replace(/\/$/, '');
      if (!/\/in\/[^/]+$/.test(href)) continue;

      // Walk up to the card: the nearest ancestor that also holds the
      // headline/location lines.
      let card = link;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        card = card.parentElement;
        if (card.tagName === 'LI' || card.getAttribute('data-chameleon-result-urn')) break;
      }

      // Split on newlines FIRST — collapsing whitespace before splitting
      // destroys the line structure the name/headline/location order relies on.
      const lines = (card.innerText || '')
        .split('\n')
        .map(clean)
        .filter(Boolean)
        .filter((l) => !/^(status is|·|Connect|Follow|Message|View .*profile|\d+(st|nd|rd|th) degree)/i.test(l));

      // The anchor's own text is the most reliable name source.
      let name = clean((link.innerText || '').split('\n')[0]) || lines[0] || '';
      name = name.replace(/\s*·.*$/, '').replace(/View .*/i, '').trim();
      if (!name || name.length > 80) continue;

      const rest = lines.filter((l) => l !== name);
      // Location lines are short and comma-separated with no verbs; headline
      // is the first remaining line.
      const headline = rest[0] || '';
      const location = rest.find((l, i) => i > 0 && /,/.test(l) && l.length < 60) || rest[1] || '';

      const existing = byProfile.get(href);
      if (!existing || headline.length > existing.headline.length) {
        byProfile.set(href, { name, headline, location, url: href });
      }
    }

    return Array.from(byProfile.values());
  });
}

/**
 * Scrolls a results page the way a person reads it, collecting cards as they
 * render (LinkedIn lazy-loads). Returns deduped rows.
 */
async function harvestResultsPage(page, persona, config) {
  const collected = new Map();

  const passes = randInt(3, 6);
  for (let i = 0; i < passes; i++) {
    const cards = await extractResultCards(page);
    for (const c of cards) if (c.url) collected.set(c.url, c);

    await humanScroll(page, persona, { depth: 'partial' });
    await pause(persona, config.pacing.actionDelayMs);

    if (await detectBlock(page)) break;
  }

  // One last read after the final lazy-load settles.
  await sleep(humanDelay(1200, 3000));
  for (const c of await extractResultCards(page)) if (c.url) collected.set(c.url, c);

  return Array.from(collected.values());
}

/** Goes to the next results page via the real pagination control. */
async function goToNextPage(page, persona, config) {
  const next = page.locator(
    'button[aria-label="Next"], button:has-text("Next"), a[aria-label="Next"]'
  ).first();

  if (!(await next.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  if (await next.isDisabled().catch(() => false)) return false;

  await scrollToElement(page, next, persona);
  await pause(persona, config.pacing.actionDelayMs);
  await humanClick(page, next, persona);
  await page.waitForLoadState('domcontentloaded');
  await sleep(humanDelay(3000, 7000));
  return true;
}

// ---------------------------------------------------------------------------
// Profile detail
// ---------------------------------------------------------------------------

/**
 * Opens one profile and reads title / company / location. Profile visits are
 * the most expensive action against the daily budget, so this is called only
 * for leads that already look worth the spend after the search-card pass.
 */
async function visitProfile(page, persona, config, lead) {
  await page.goto(lead.url, { waitUntil: 'domcontentloaded' });
  await sleep(humanDelay(2500, 5000));

  const block = await detectBlock(page);
  if (block) throw new Error(`BLOCKED: ${block}`);

  // Read it like a human before touching the DOM for data.
  await humanScroll(page, persona, { depth: 'partial' });
  await dwell(persona, config.pacing.profileDwellMs);

  const detail = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const txt = (sel) => clean(document.querySelector(sel)?.innerText);

    const name = txt('h1') || '';

    // The headline is the block immediately after the h1.
    const headline =
      txt('.text-body-medium.break-words') ||
      txt('div.text-body-medium') || '';

    const location =
      txt('.text-body-small.inline.t-black--light.break-words') ||
      txt('span.text-body-small:not(.inline-show-more-text)') || '';

    // Current company: the top-card experience aside, else the first
    // Experience entry, else the segment after "at" in the headline.
    let company = '';
    const topCardCompany = document.querySelector(
      'button[aria-label*="Current company" i], .pv-text-details__right-panel-item-text'
    );
    if (topCardCompany) company = clean(topCardCompany.innerText);

    if (!company) {
      const expSection = Array.from(document.querySelectorAll('section')).find((s) =>
        /experience/i.test(s.querySelector('h2')?.innerText || '')
      );
      if (expSection) {
        const first = expSection.querySelector('li');
        if (first) {
          const lines = clean(first.innerText).split('\n').map(clean).filter(Boolean);
          company = lines[1] || '';
        }
      }
    }

    if (!company) {
      const m = headline.match(/\bat\s+(.+?)(\s*[|·]|$)/i);
      if (m) company = clean(m[1]);
    }

    company = company.replace(/\s*·.*$/, '').replace(/\s*\bFull-time\b.*/i, '').trim();

    // Company LinkedIn page, useful for finding the website later.
    const companyLink =
      document.querySelector('a[href*="/company/"]')?.href?.split('?')[0] || '';

    return { name, headline, location, company, companyLinkedIn: companyLink };
  });

  // Occasionally scroll further, as a person reading a promising profile would.
  if (chance(0.5)) {
    await humanScroll(page, persona, { depth: 'partial' });
    await pause(persona, config.pacing.actionDelayMs);
  }

  return {
    ...lead,
    name: detail.name || lead.name,
    title: detail.headline || lead.headline || '',
    company: detail.company || '',
    location: detail.location || lead.location || '',
    companyLinkedIn: detail.companyLinkedIn || '',
  };
}

module.exports = {
  runSearch, harvestResultsPage, goToNextPage, visitProfile, extractResultCards, humanOrder,
};
