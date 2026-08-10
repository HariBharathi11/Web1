/**
 * careers.js — hiring-volume validation.
 *
 * The rubric turns on hiring volume, and a headline alone cannot tell you that.
 * This resolves each lead's company to a website, finds its careers page, and
 * counts live openings — which is the only cheap, checkable proxy for whether
 * the screening pain the pitch describes is actually happening there.
 *
 * These visits run in a SEPARATE, cookie-less browser context. Company sites
 * are ordinary public web pages; hitting them from the logged-in LinkedIn
 * profile would both leak the session and add avoidable traffic to it.
 */

const { humanDelay, sleep, quickScroll, rand, chance } = require('./humanize');

// ---------------------------------------------------------------------------
// Resolve company → website
// ---------------------------------------------------------------------------

/** Reads the website link off a LinkedIn company About page. */
async function websiteFromLinkedInCompany(page, companyLinkedIn, persona) {
  if (!companyLinkedIn) return '';
  const aboutUrl = companyLinkedIn.replace(/\/$/, '') + '/about/';
  try {
    await page.goto(aboutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(humanDelay(2000, 4500));
    await quickScroll(page);

    return await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const ext = links
        .map((a) => a.href)
        .find((h) => /^https?:\/\//.test(h) && !/linkedin\.com/.test(h) && !/licdn\.com/.test(h));
      return ext || '';
    });
  } catch {
    return '';
  }
}

/** Last-resort guess from the company name, verified by an actual fetch. */
function guessDomains(companyName) {
  const slug = (companyName || '')
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|inc|llp|llc|technologies|solutions|group|india)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  if (!slug || slug.length < 3) return [];
  return [`https://www.${slug}.com`, `https://${slug}.com`, `https://www.${slug}.in`, `https://${slug}.co.in`];
}

// ---------------------------------------------------------------------------
// Careers page + counting
// ---------------------------------------------------------------------------

/**
 * Counts things that look like job listings. Careers pages have no standard
 * markup, so this triangulates: explicit job-link patterns, ATS embeds
 * (Greenhouse / Lever / Workday / Zoho / Keka are what Indian mid-market
 * actually runs), and repeated role-title text as a floor.
 */
async function countOpenings(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    // 1. Links that clearly point at an individual posting.
    const jobLinkPattern =
      /(\/job[s]?\/|\/careers?\/[^/]+\/?$|\/opening|\/position|\/vacanc|greenhouse\.io\/[^/]+\/jobs\/|lever\.co\/[^/]+\/|workday|zohorecruit|keka\.com|smartrecruiters|freshteam)/i;
    const links = Array.from(document.querySelectorAll('a[href]'));
    const jobLinks = new Set(
      links
        .filter((a) => jobLinkPattern.test(a.href) && clean(a.innerText).length > 2)
        .map((a) => a.href.split('?')[0])
    );

    // 2. Role-title text, as a floor when postings are rendered without links.
    const roleWords =
      /\b(engineer|developer|manager|analyst|executive|specialist|lead|consultant|designer|architect|associate|intern|officer|recruiter|accountant|sales|marketing|operations|technician|supervisor|trainee)\b/i;
    const textCandidates = Array.from(
      document.querySelectorAll('h2, h3, h4, li, [class*="job" i], [class*="opening" i], [class*="position" i]')
    )
      .map((el) => clean(el.innerText))
      .filter((t) => t.length > 4 && t.length < 90 && roleWords.test(t));
    const uniqueRoles = new Set(textCandidates.map((t) => t.toLowerCase()));

    // 3. Some sites just print the number.
    let stated = 0;
    const bodyText = clean(document.body.innerText);
    const m = bodyText.match(/(\d{1,4})\s+(open\s+)?(positions?|openings?|jobs?|roles?|vacanc(y|ies))/i);
    if (m) stated = parseInt(m[1], 10);

    // 4. Whether an ATS is embedded at all — itself a hiring-maturity signal.
    const atsHit = /greenhouse|lever\.co|workday|zohorecruit|keka|smartrecruiters|freshteam|darwinbox|recruitee/i.test(
      document.documentElement.innerHTML
    );

    const counted = Math.max(jobLinks.size, Math.min(uniqueRoles.size, 300));
    return {
      openings: Math.max(counted, stated > 0 && stated < 2000 ? stated : 0),
      jobLinks: jobLinks.size,
      roleTextMatches: uniqueRoles.size,
      statedCount: stated,
      atsDetected: atsHit,
      pageTitle: clean(document.title).slice(0, 120),
    };
  });
}

/** Reads a page and counts openings on it. */
async function readCareersPage(page, url, config) {
  const resp = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: config.careersValidation.timeoutMs,
  });
  if (!resp || resp.status() >= 400) return null;
  await sleep(200 + Math.random() * 400);
  await quickScroll(page);
  return { ...(await countOpenings(page)), careersUrl: page.url().split('?')[0] };
}

/**
 * Finds and reads a company's careers page.
 *
 * Order matters, and it is deliberate:
 *
 * 1. **Follow the site's own careers link first.** One request, and it is by far
 *    the highest-yield route — the company tells you where its jobs live,
 *    including when they live on another host entirely (jobs.acme.com,
 *    boards.greenhouse.io/acme). Guessing paths can never find those.
 * 2. **Only then guess common paths**, and guess *all* of them rather than a
 *    sample. An earlier version shuffled nine candidates and tried five, which
 *    silently missed /jobs about 44% of the time — a company with a dozen live
 *    roles would score zero on Timing and drop out of the pipeline entirely.
 *    Wrong-but-fast is worse than slow here, because a false zero looks
 *    identical to a genuinely quiet company.
 */
async function probeCareers(page, baseUrl, config) {
  const origin = (() => {
    try { return new URL(baseUrl).origin; } catch { return null; }
  })();
  if (!origin) return null;

  // --- 1. the site's own careers link ---------------------------------------
  try {
    if (!page.url().startsWith(origin)) {
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: config.careersValidation.timeoutMs });
      await sleep(200 + Math.random() * 400);
    }

    const href = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      // Prefer an explicit "careers"/"jobs" label over an incidental match.
      const scored = links
        .map((a) => {
          const text = (a.innerText || '').trim().toLowerCase();
          const url = a.href.toLowerCase();
          let score = 0;
          if (/^(careers?|jobs|vacancies|openings)$/.test(text)) score += 10;
          if (/\b(career|job|join us|work with us|we.re hiring|current opening)/.test(text)) score += 5;
          if (/\/(careers?|jobs|vacanc|openings)/.test(url)) score += 4;
          if (/greenhouse\.io|lever\.co|workday|zohorecruit|keka|smartrecruiters|freshteam|darwinbox/.test(url)) score += 8;
          return { href: a.href, score };
        })
        .filter((x) => x.score > 0 && /^https?:/.test(x.href))
        .sort((a, b) => b.score - a.score);
      return scored.length ? scored[0].href : '';
    });

    if (href) {
      await sleep(150 + Math.random() * 350);
      const result = await readCareersPage(page, href, config);
      if (result && (result.openings > 0 || result.atsDetected)) return result;
    }
  } catch { /* fall through to path guessing */ }

  // --- 2. every common path, in random order --------------------------------
  const paths = [...config.careersValidation.candidatePaths].sort(() => Math.random() - 0.5);
  for (const p of paths) {
    try {
      const result = await readCareersPage(page, origin + p, config);
      if (result && (result.openings > 0 || result.atsDetected)) return result;
    } catch { /* dead path, next */ }
  }

  return null;
}

/**
 * Validates one lead. `liPage` is the logged-in LinkedIn page (used only to
 * read the company's website); `webPage` is the clean context used for the
 * company's own site.
 */
async function validateHiring(liPage, webPage, lead, config, persona) {
  const result = {
    careersUrl: '', openings: 0, atsDetected: false,
    website: '', hiringSignal: 'unknown', validationNote: '',
  };

  if (!config.careersValidation.enabled) {
    result.validationNote = 'careers validation disabled in config';
    return result;
  }

  let website = await websiteFromLinkedInCompany(liPage, lead.companyLinkedIn, persona);

  if (!website) {
    for (const guess of guessDomains(lead.company)) {
      try {
        const r = await webPage.goto(guess, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (r && r.status() < 400) { website = guess; break; }
      } catch { /* keep guessing */ }
    }
  }

  if (!website) {
    result.validationNote = 'could not resolve a company website';
    return result;
  }
  result.website = website;

  const probe = await probeCareers(webPage, website, config, persona);
  if (!probe) {
    result.validationNote = 'website found, no readable careers page';
    return result;
  }

  result.careersUrl = probe.careersUrl;
  result.openings = probe.openings;
  result.atsDetected = probe.atsDetected;

  // Openings live on a page are a snapshot; monthly posting rate is roughly
  // the live count, and quarterly hires run higher than live openings.
  if (probe.openings >= 40) result.hiringSignal = 'high';
  else if (probe.openings >= config.scoring.midMarketOpenRolesMin) result.hiringSignal = 'medium';
  else if (probe.openings > 0) result.hiringSignal = 'low';
  else result.hiringSignal = probe.atsDetected ? 'low' : 'none';

  result.validationNote =
    `${probe.openings} live openings (links:${probe.jobLinks}, text:${probe.roleTextMatches}` +
    `${probe.statedCount ? `, stated:${probe.statedCount}` : ''})${probe.atsDetected ? ', ATS detected' : ''}`;

  return result;
}

module.exports = { validateHiring, countOpenings, probeCareers, guessDomains };
