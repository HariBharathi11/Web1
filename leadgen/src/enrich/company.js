/**
 * enrich/company.js — company-level enrichment.
 *
 * Enriches COMPANIES, not people. There are far fewer of them (2,000
 * connections collapse to roughly 600 companies), and everyone at a company
 * shares its hiring signal — so doing this work per-company rather than
 * per-person is where most of the time and token saving in the whole pipeline
 * comes from.
 *
 * All of it runs in a cookie-less browser context against public pages. It
 * never touches LinkedIn, so it costs nothing against the daily profile budget
 * and carries no account risk.
 *
 * Produces: domain, region, socials, careers URL, live openings, ATS.
 */

const { humanDelay, sleep, humanScroll } = require('../humanize');
const { probeCareers, guessDomains } = require('../careers');
const { regionOf } = require('../venn');
const { upsertCompany, addSignal } = require('../db');

// ---------------------------------------------------------------------------
// Socials — harvested from the company's own site
// ---------------------------------------------------------------------------

/**
 * Reads social handles out of the page (almost always the footer).
 *
 * This is how the Instagram / Facebook / WhatsApp roadmap gets built without
 * touching those platforms now: the handles are published by the company on
 * its own website, so collecting them is a single ordinary page fetch. When
 * the GTM widens past LinkedIn, the channel data is already sitting in the DB.
 */
async function extractSocials(page) {
  return page.evaluate(() => {
    const out = {};
    const patterns = {
      linkedin: /linkedin\.com\/(company|in)\//i,
      instagram: /instagram\.com\//i,
      facebook: /facebook\.com\//i,
      twitter: /(twitter\.com|x\.com)\//i,
      youtube: /youtube\.com\//i,
      whatsapp: /(wa\.me|api\.whatsapp\.com)\//i,
    };
    for (const a of document.querySelectorAll('a[href]')) {
      for (const [key, re] of Object.entries(patterns)) {
        if (!out[key] && re.test(a.href) && !/sharer|share\?|intent\/tweet/i.test(a.href)) {
          out[key] = a.href.split('?')[0];
        }
      }
    }

    // A contact email published on the site is a legitimate, public channel.
    const mail = Array.from(document.querySelectorAll('a[href^="mailto:"]'))
      .map((a) => a.href.replace(/^mailto:/, '').split('?')[0])
      .find((e) => /@/.test(e) && !/example\./i.test(e));
    if (mail) out.email = mail;

    return out;
  });
}

/** Region from address-ish text on the site, falling back to the TLD. */
async function inferRegion(page, domain, config) {
  const text = await page.evaluate(() => {
    // Footers hold the registered address far more often than anywhere else.
    const foot = document.querySelector('footer');
    return ((foot ? foot.innerText : '') + ' ' + document.body.innerText.slice(-3000))
      .replace(/\s+/g, ' ')
      .slice(0, 4000);
  }).catch(() => '');

  const byText = regionOf(text, config);
  if (byText !== 'OTHER') return byText;

  const tld = (domain || '').toLowerCase();
  if (/\.(in|co\.in)(\/|$)/.test(tld)) return 'IN';
  if (/\.(ae|sa|qa|kw|bh|om)(\/|$)/.test(tld)) return 'GULF';
  if (/\.sg(\/|$)/.test(tld)) return 'SG';
  if (/\.(uk|co\.uk|de|fr|nl|es|it|ie|se|ch|be|pt|pl)(\/|$)/.test(tld)) return 'EU';
  return 'OTHER';
}

/** Rough size band from a self-description. Weak signal, clearly labelled. */
async function inferSize(page) {
  return page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    const m = t.match(/([\d,]{2,7})\+?\s*(employees|people|professionals|team members|associates)/i);
    if (!m) return null;
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (!n || n > 2000000) return null;
    if (n >= 5000) return '5000+';
    if (n >= 1000) return '1000-5000';
    if (n >= 500) return '500-1000';
    if (n >= 100) return '100-500';
    return '<100';
  }).catch(() => null);
}

// ---------------------------------------------------------------------------
// Domain resolution
// ---------------------------------------------------------------------------

/**
 * Finds the company's website. Tries the LinkedIn company page only when we
 * already have its URL (it costs a LinkedIn request, so it is the fallback,
 * not the default), otherwise guesses domains from the name and verifies each
 * with a real fetch — a guess that does not resolve is not a domain.
 */
async function resolveDomain(webPage, company) {
  if (company.domain) return company.domain;

  for (const guess of guessDomains(company.name)) {
    try {
      const r = await webPage.goto(guess, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (r && r.status() < 400) {
        // Guard against parked/for-sale pages masquerading as a company site.
        const looksParked = await webPage.evaluate(() =>
          /domain (is )?for sale|buy this domain|parked (free )?courtesy/i.test(document.body.innerText.slice(0, 2000))
        ).catch(() => false);
        if (!looksParked) return webPage.url().split('?')[0];
      }
    } catch { /* next guess */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Enriches one company in place. Writes what it learns straight to the DB so a
 * crash mid-batch never loses the work already paid for.
 */
async function enrichCompany(db, webPage, company, config, persona) {
  const result = { id: company.id, name: company.name, changed: false, note: '' };

  const domain = await resolveDomain(webPage, company);
  if (!domain) {
    // Record the attempt so the next run does not pay for it again.
    upsertCompany(db, { name: company.name, openings_checked_at: new Date().toISOString() });
    result.note = 'no resolvable website';
    return result;
  }

  let socials = {}, region = null, size = null;
  try {
    await webPage.goto(domain, { waitUntil: 'domcontentloaded', timeout: config.careersValidation.timeoutMs });
    await sleep(humanDelay(1200, 3000));
    await humanScroll(webPage, persona, { depth: 'partial' }); // footers need a scroll
    socials = await extractSocials(webPage);
    region = await inferRegion(webPage, domain, config);
    size = await inferSize(webPage);
  } catch {
    result.note = 'homepage unreachable';
  }

  let careers = null;
  if (config.careersValidation.enabled) {
    try {
      careers = await probeCareers(webPage, domain, config, persona);
    } catch { /* careers page is optional */ }
  }

  upsertCompany(db, {
    name: company.name,
    domain,
    region: region || undefined,
    size_band: size || undefined,
    socials,
    careers_url: careers?.careersUrl,
    ats: careers?.atsDetected ? 'detected' : undefined,
    // Only write a count when we actually read a careers page. A site that is
    // briefly down must not silently zero a good count from last week and drop
    // the account out of Band A — the checked-at stamp still updates, so the
    // Timing axis ages the stale figure instead of trusting a false zero.
    ...(careers ? { live_openings: careers.openings } : {}),
    openings_checked_at: new Date().toISOString(),
  });

  if (careers?.openings > 0) {
    addSignal(db, {
      entity_type: 'company', entity_id: company.id, kind: 'hiring_volume',
      value: careers.openings, detail: `${careers.openings} live openings`, source: careers.careersUrl,
    });
  }
  if (careers?.atsDetected) {
    addSignal(db, {
      entity_type: 'company', entity_id: company.id, kind: 'ats',
      detail: 'ATS embed detected on careers page', source: careers.careersUrl,
    });
  }

  result.changed = true;
  result.note = `${domain}${careers ? ` · ${careers.openings} openings` : ' · no careers page'}` +
                `${region && region !== 'OTHER' ? ` · ${region}` : ''}` +
                `${Object.keys(socials).length ? ` · ${Object.keys(socials).length} socials` : ''}`;
  return result;
}

module.exports = { enrichCompany, extractSocials, inferRegion, inferSize, resolveDomain };
