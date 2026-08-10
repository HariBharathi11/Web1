/**
 * profile/extract.js — reads your own LinkedIn profile.
 *
 * Selectors are defensive for the same reason as scrape.js: LinkedIn's class
 * names are hashed and rotate. Everything here is anchored to stable structure
 * (section ids, aria labels, heading text) with fallbacks, and each field
 * reports whether it was actually found — a missing element and a failed
 * selector must never look the same, because "you have no Featured section" and
 * "I could not read your Featured section" lead to opposite advice.
 */

const { sleep, humanDelay, humanScroll, dwell } = require('../humanize');

/** Pulls everything the rubric needs in one page-context pass. */
async function extractProfile(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? clean(el.innerText) : null;
    };

    const sectionByHeading = (re) =>
      Array.from(document.querySelectorAll('section')).find((s) => {
        const h = s.querySelector('h2, .pvs-header__title, [class*="header"] span');
        return h && re.test(clean(h.innerText));
      }) || null;

    // --- identity ----------------------------------------------------------
    const name = text('h1');
    const headline = text('.text-body-medium.break-words') || text('div.text-body-medium');
    const location = text('.text-body-small.inline.t-black--light.break-words');

    // --- photo: LinkedIn serves a known ghost image when none is set --------
    const photoEl = document.querySelector('img.pv-top-card-profile-picture__image, img[class*="profile-photo"], .pv-top-card__photo img');
    const hasPhoto = !!(photoEl && photoEl.src && !/ghost|default|anonymous/i.test(photoEl.src));

    // --- banner ------------------------------------------------------------
    const bannerEl = document.querySelector('.profile-background-image img, [class*="cover-img"] img, [class*="background-image"] img');
    const hasBanner = !!(bannerEl && bannerEl.src && !/default|placeholder/i.test(bannerEl.src));

    // --- custom CTA button (Visit website / Book an appointment) ------------
    const ctaEl = Array.from(document.querySelectorAll('a[class*="artdeco-button"], .pv-top-card a'))
      .find((a) => /visit (my )?website|book an appointment|view portfolio|sign up|register|learn more|contact us/i.test(clean(a.innerText)));
    const cta = ctaEl ? { label: clean(ctaEl.innerText), href: ctaEl.href } : null;

    // --- followers / connections -------------------------------------------
    const body = clean(document.body.innerText);
    const followersMatch = body.match(/([\d,]+)\s+followers?/i);
    const connMatch = body.match(/([\d,]+\+?)\s+connections?/i);
    const followers = followersMatch ? parseInt(followersMatch[1].replace(/,/g, ''), 10) : null;
    const connections = connMatch ? connMatch[1] : null;

    // --- About -------------------------------------------------------------
    const aboutSection = document.querySelector('#about')?.closest('section') || sectionByHeading(/^about$/i);
    let about = null;
    if (aboutSection) {
      const span = aboutSection.querySelector('.display-flex.full-width span[aria-hidden="true"], .inline-show-more-text span[aria-hidden="true"], .pv-shared-text-with-see-more span');
      about = clean(span ? span.innerText : aboutSection.innerText.replace(/^About/i, ''));
    }

    // --- Featured ----------------------------------------------------------
    const featuredSection = document.querySelector('#featured')?.closest('section') || sectionByHeading(/^featured$/i);
    const featuredItems = featuredSection
      ? Array.from(featuredSection.querySelectorAll('li')).map((li) => clean(li.innerText).slice(0, 120)).filter(Boolean)
      : [];

    // --- Experience --------------------------------------------------------
    const expSection = document.querySelector('#experience')?.closest('section') || sectionByHeading(/^experience$/i);
    const experience = expSection
      ? Array.from(expSection.querySelectorAll('li.artdeco-list__item, li'))
          .map((li) => clean(li.innerText).split('\n')[0])
          .filter((t) => t && t.length < 120)
          .slice(0, 6)
      : [];

    // --- Skills / recommendations ------------------------------------------
    const skillsSection = document.querySelector('#skills')?.closest('section') || sectionByHeading(/^skills$/i);
    const skills = skillsSection
      ? Array.from(skillsSection.querySelectorAll('li')).map((li) => clean(li.innerText).split('\n')[0]).filter(Boolean).slice(0, 30)
      : [];

    const recSection = document.querySelector('#recommendations')?.closest('section') || sectionByHeading(/^recommendations$/i);
    const recommendationsText = recSection ? clean(recSection.innerText) : '';
    const recReceived = (recommendationsText.match(/received/i) ? (recSection.querySelectorAll('li').length || 0) : 0);

    // --- Creator mode / services -------------------------------------------
    const creatorMode = /creator mode|top voice|talks about/i.test(body);
    const talksAbout = (body.match(/talks about\s*([^\n]{0,120})/i) || [])[1] || null;
    const openToWork = /open to work/i.test(body);
    const providesServices = /provides services/i.test(body);

    return {
      name, headline, location, hasPhoto, hasBanner, cta,
      followers, connections,
      about,
      featuredCount: featuredItems.length,
      featuredItems,
      featuredSectionPresent: !!featuredSection,
      experience,
      skillsCount: skills.length,
      recommendationsCount: recReceived,
      creatorMode, talksAbout, openToWork, providesServices,
      aboutSectionPresent: !!aboutSection,
    };
  });
}

/**
 * Reads the activity feed — post cadence and engagement.
 *
 * This matters more than it looks: an HR leader who clicks through from your
 * message and finds nothing posted since March quietly discounts you. Cadence
 * and average engagement are measured here rather than assumed.
 */
async function extractActivity(page, profileUrl, persona) {
  const url = profileUrl.replace(/\/$/, '') + '/recent-activity/all/';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(humanDelay(2500, 5000));
    await humanScroll(page, persona, { depth: 'partial' });

    return await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const posts = Array.from(document.querySelectorAll('.feed-shared-update-v2, [data-urn*="activity"], li.profile-creator-shared-feed-update__container'));

      const parsed = posts.slice(0, 20).map((p) => {
        const t = clean(p.innerText);
        // "2w •", "3mo •", "1d •" — LinkedIn's relative timestamps
        const age = (t.match(/\b(\d+)\s*(m|h|d|w|mo|yr)\b/) || []);
        const reactions = parseInt((t.match(/([\d,]+)\s*(reaction|like)/i) || [0, '0'])[1].replace(/,/g, ''), 10) || 0;
        const comments = parseInt((t.match(/([\d,]+)\s*comment/i) || [0, '0'])[1].replace(/,/g, ''), 10) || 0;
        return { ageValue: parseInt(age[1], 10) || null, ageUnit: age[2] || null, reactions, comments, snippet: t.slice(0, 140) };
      });

      return { count: parsed.length, posts: parsed };
    });
  } catch {
    return { count: 0, posts: [], error: 'could not read activity feed' };
  }
}

/** Relative age → days, for cadence maths. */
function ageInDays(p) {
  if (!p.ageValue || !p.ageUnit) return null;
  const mult = { m: 1 / 1440, h: 1 / 24, d: 1, w: 7, mo: 30, yr: 365 }[p.ageUnit];
  return mult ? p.ageValue * mult : null;
}

module.exports = { extractProfile, extractActivity, ageInDays };
