/**
 * session.js — browser session, login handling, and the safety governor.
 *
 * Design decision worth stating up front: this uses a *persistent, real,
 * headed Chromium profile* that YOU (or the client) log into by hand, once.
 * No stored password, no scripted login, no headless mode, no fingerprint
 * forgery. That is not a compromise — it is what actually keeps the account
 * healthy:
 *
 *  - Scripted logins are the single most flagged event on the platform.
 *    A profile that logs in once and then persists its cookies looks like a
 *    person's everyday browser, because it is one.
 *  - Headless Chrome is trivially detectable, and "stealth" patches are an
 *    arms race you lose on their timetable. A real headed browser has nothing
 *    to patch.
 *  - Volume and rhythm are what actually trigger restrictions. The governor
 *    below caps both, and it is the most important file in this repo.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { sleep, humanDelay, randInt, chance, humanClick } = require('./humanize');

const STATE_DIR = path.resolve(__dirname, '..', '.state');
const COUNTER_FILE = path.join(STATE_DIR, 'usage.json');

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Usage governor
// ---------------------------------------------------------------------------

function loadUsage() {
  ensureStateDir();
  if (!fs.existsSync(COUNTER_FILE)) return { days: {}, runs: [] };
  try {
    return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
  } catch {
    return { days: {}, runs: [] };
  }
}

function saveUsage(u) {
  ensureStateDir();
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(u, null, 2));
}

function todayKey(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

function localHour(tz) {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date())
  );
}

function localWeekday(tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date());
}

/**
 * Refuses to start a run that would look mechanical: outside working hours,
 * on a weekend, too soon after the last run, or over the daily profile cap.
 * Returns { ok, reason }.
 */
function checkGovernor(config) {
  const L = config.limits;
  const tz = L.activeHours.timezone;
  const usage = loadUsage();
  const day = todayKey(tz);
  const today = usage.days[day] || { runs: 0, profiles: 0 };

  const hour = localHour(tz);
  if (hour < L.activeHours.startHour || hour >= L.activeHours.endHour) {
    return { ok: false, reason: `outside active hours (${hour}:00 ${tz}, allowed ${L.activeHours.startHour}–${L.activeHours.endHour})` };
  }

  if (L.skipWeekends && ['Sat', 'Sun'].includes(localWeekday(tz))) {
    return { ok: false, reason: 'weekend — real recruiters are not sourcing at this hour, and neither should this account' };
  }

  if (today.runs >= L.maxRunsPerDay) {
    return { ok: false, reason: `daily run cap reached (${today.runs}/${L.maxRunsPerDay})` };
  }

  if (today.profiles >= L.hardDailyProfileCap) {
    return { ok: false, reason: `daily profile-view cap reached (${today.profiles}/${L.hardDailyProfileCap})` };
  }

  const lastRun = usage.runs[usage.runs.length - 1];
  if (lastRun) {
    const mins = (Date.now() - lastRun.finishedAt) / 60000;
    if (mins < L.cooldownBetweenRunsMinutes) {
      return { ok: false, reason: `cooldown active — ${Math.ceil(L.cooldownBetweenRunsMinutes - mins)} min remaining` };
    }
  }

  return { ok: true, today };
}

function recordRun(config, { profilesViewed }) {
  const tz = config.limits.activeHours.timezone;
  const usage = loadUsage();
  const day = todayKey(tz);
  usage.days[day] = usage.days[day] || { runs: 0, profiles: 0 };
  usage.days[day].runs += 1;
  usage.days[day].profiles += profilesViewed;
  usage.runs.push({ finishedAt: Date.now(), day, profilesViewed });
  usage.runs = usage.runs.slice(-50);
  saveUsage(usage);
}

/** Live counter so a run can stop itself mid-flight at the daily cap. */
function remainingProfileBudget(config) {
  const tz = config.limits.activeHours.timezone;
  const usage = loadUsage();
  const today = usage.days[todayKey(tz)] || { profiles: 0 };
  return Math.max(0, config.limits.hardDailyProfileCap - today.profiles);
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/**
 * Opens the persistent profile. `profileName` lets one machine hold several
 * separate identities (yours, each client's) with zero cookie bleed between
 * them — each gets its own directory, its own viewport, its own locale.
 */
async function launchSession(config, profileName = 'default') {
  ensureStateDir();
  const userDataDir = path.join(STATE_DIR, 'profiles', profileName);
  fs.mkdirSync(userDataDir, { recursive: true });

  // Microsoft Edge, driven through Playwright's `channel`. Edge is Chromium
  // underneath, so everything in humanize.js works identically — but it is the
  // browser actually installed on this machine and the one whose fingerprint
  // matches every other thing this user does. Running the real everyday browser
  // is less anomalous than running a bundled Chromium that exists nowhere else
  // on the system.
  const channel = config.browser?.channel || 'msedge';

  // A stable-but-plausible viewport per profile. Constant across runs for the
  // same profile (a person's monitor does not change daily), different between
  // profiles.
  const viewports = [
    { width: 1440, height: 900 }, { width: 1512, height: 945 },
    { width: 1366, height: 768 }, { width: 1680, height: 1050 },
  ];
  const vpIndex = [...profileName].reduce((a, c) => a + c.charCodeAt(0), 0) % viewports.length;

  const launchOpts = {
    channel,
    headless: false, // never headless — see the file header
    viewport: viewports[vpIndex],
    locale: 'en-IN',
    timezoneId: config.limits.activeHours.timezone,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, launchOpts);
  } catch (e) {
    if (/channel|executable|not found|Failed to launch/i.test(e.message)) {
      throw new Error(
        `Could not launch Microsoft Edge (channel "${channel}").\n` +
        `  • Install Edge, or run:  npx playwright install msedge\n` +
        `  • Or set browser.channel to "chrome" or null (bundled Chromium) in config.json\n` +
        `Original error: ${e.message.split('\n')[0]}`
      );
    }
    throw e;
  }

  context.setDefaultTimeout(45000);
  return { context, userDataDir, channel };
}

/**
 * Confirms the profile is logged in. If it is not, it opens the login page and
 * WAITS for a human to sign in by hand (including any 2FA / captcha). It never
 * types credentials. First run is interactive; every run after that is not,
 * because the profile keeps the session cookie.
 */
/** Are we on a real logged-in LinkedIn page? */
async function isAuthenticated(page) {
  const url = page.url();
  if (/\/(login|checkpoint|authwall|uas\/login)/.test(url)) return false;
  if (!/linkedin\.com/.test(url)) return false;
  // The global nav only renders for a signed-in session.
  return page.locator('#global-nav, .global-nav, [data-test-global-nav]')
    .first().isVisible({ timeout: 5000 }).catch(() => false);
}

/**
 * Clicks LinkedIn's "Continue with Google" button.
 *
 * LinkedIn renders Google sign-in three different ways depending on the
 * session: a Google One Tap iframe, an inline button, or a plain link on the
 * /login page. This tries all three and reports whether it managed to start
 * the flow — it never types an email or password, and never chooses an account.
 * Picking the Google account, and any 2FA, is yours.
 */
async function clickGoogleSignIn(page, persona) {
  const inlineSelectors = [
    'button:has-text("Continue with Google")',
    'a:has-text("Continue with Google")',
    'button:has-text("Sign in with Google")',
    '[aria-label*="Continue with Google" i]',
    '[data-test-id*="google" i]',
  ];

  for (const sel of inlineSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2500 }).catch(() => false)) {
      await humanClick(page, el, persona);
      return 'inline button';
    }
  }

  // Google One Tap renders inside a cross-origin iframe.
  for (const frame of page.frames()) {
    if (!/accounts\.google\.com|gsi/.test(frame.url())) continue;
    for (const sel of ['div[role="button"]', 'button', '#container']) {
      const el = frame.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click({ delay: randInt(40, 120) }).catch(() => {});
        return 'One Tap iframe';
      }
    }
  }

  return null;
}

/**
 * Confirms the profile is signed in, and if not, opens the Google sign-in flow
 * and WAITS for you to complete it by hand.
 *
 * The script never types your email or password, never selects an account, and
 * never touches a 2FA code. It clicks "Continue with Google" and then watches
 * until LinkedIn is authenticated. Everything in between is yours — which is
 * both the safe design and the only one that works with Google's own automation
 * detection, since a scripted Google login is far more likely to be challenged
 * than a scripted LinkedIn one.
 *
 * After the first run the Edge profile keeps the session, so this returns
 * immediately every subsequent day.
 */
async function ensureLoggedIn(page, persona, { timeoutMinutes = 10 } = {}) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await sleep(humanDelay(2500, 5000));

  if (await isAuthenticated(page)) {
    console.log('✔ Already signed in — the Edge profile remembered the session.');
    return true;
  }

  // Land on the login page so the Google button is present.
  if (!/\/(login|uas\/login)/.test(page.url())) {
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
    await sleep(humanDelay(1500, 3500));
  }

  const clicked = await clickGoogleSignIn(page, persona);

  console.log('\n┌───────────────────────────────────────────────────────────────┐');
  if (clicked) {
    console.log(`│  Opened Google sign-in (${clicked}).`.padEnd(64) + '│');
    console.log('│  Pick your Google account in the window and finish 2FA.       │');
  } else {
    console.log('│  Could not find the Google button — sign in however you like. │');
  }
  console.log('│                                                               │');
  console.log('│  This script never types your email, password, or 2FA code.    │');
  console.log(`│  Waiting up to ${String(timeoutMinutes).padEnd(2)} minutes…`.padEnd(64) + '│');
  console.log('└───────────────────────────────────────────────────────────────┘\n');

  // Google may open its account chooser in a popup window rather than in-page.
  page.context().on('page', async (popup) => {
    if (/accounts\.google\.com/.test(popup.url())) {
      console.log('   … Google account chooser opened in a new window. Complete it there.');
    }
  });

  const deadline = Date.now() + timeoutMinutes * 60000;
  let announced = false;

  while (Date.now() < deadline) {
    await sleep(3000);

    if (await isAuthenticated(page)) {
      console.log('✔ Signed in. This profile will remember it — no login next run.');
      await sleep(humanDelay(2000, 4000));
      return true;
    }

    // If the user finished in a popup, LinkedIn sometimes leaves the original
    // tab on the login page. Nudge it once rather than timing out beside a
    // session that is actually live.
    if (!announced && /accounts\.google\.com|\/login/.test(page.url()) && Date.now() - deadline + timeoutMinutes * 60000 > 20000) {
      announced = true;
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }

  throw new Error('Sign-in timed out. Re-run the command and complete Google sign-in when the window opens.');
}

/**
 * Detects the states that mean "stop immediately". Continuing to act after any
 * of these is what turns a soft speed bump into a restricted account.
 */
async function detectBlock(page) {
  const url = page.url();
  if (url.includes('/checkpoint') || url.includes('/authwall')) {
    return 'checkpoint / auth wall';
  }
  const body = (await page.textContent('body').catch(() => '')) || '';
  const signals = [
    ["We've restricted", 'account restriction notice'],
    ['unusual activity', 'unusual-activity warning'],
    ['try again later', 'soft rate limit'],
    ['Please verify', 'verification challenge'],
  ];
  for (const [needle, label] of signals) {
    if (body.includes(needle)) return label;
  }
  return null;
}

/**
 * The Commercial Use Limit is NOT a block, and treating it as one wastes the
 * rest of the month.
 *
 * Free accounts get a monthly allowance of profile searches. Hit it and search
 * stops working until the 1st — typically around week three if you search
 * daily. It is a quota, not a warning: the account is in no danger, it simply
 * cannot search. The right response is to stop the cold lane and keep working
 * the warm lane, which does not consume the quota at all because it does not
 * search.
 */
async function detectCommercialLimit(page) {
  const body = (await page.textContent('body').catch(() => '')) || '';
  if (/You've reached the (monthly )?commercial use limit/i.test(body) ||
      /commercial use limit/i.test(body) ||
      /reached the monthly limit/i.test(body)) {
    return true;
  }
  return false;
}

/**
 * Works out which LinkedIn product this profile is signed into, so the run can
 * adapt rather than assume. Sales Navigator and Recruiter have their own search
 * surfaces; a free account has a monthly quota. Detection is by navigation
 * chrome, which changes far less often than any content selector.
 */
async function detectAccountTier(page) {
  try {
    const tier = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      if (/sales-?navigator|salesNav/i.test(html)) return 'sales_navigator';
      if (/talent\/hire|recruiter-?home/i.test(html)) return 'recruiter';
      if (/premium-?(badge|icon|upsell-)/i.test(html) && /premium/i.test(html)) return 'premium';
      return 'free';
    });
    return tier;
  } catch {
    return 'unknown';
  }
}

/** Occasionally do something that isn't scraping, so the session isn't pure extraction. */
async function organicDetour(page, persona) {
  const { humanScroll } = require('./humanize');
  const detours = [
    async () => {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
      await sleep(humanDelay(2000, 4000));
      await humanScroll(page, persona, { depth: 'partial' });
    },
    async () => {
      await page.goto('https://www.linkedin.com/mynetwork/', { waitUntil: 'domcontentloaded' });
      await sleep(humanDelay(2500, 6000));
      await humanScroll(page, persona, { depth: 'partial' });
    },
    async () => {
      await page.goto('https://www.linkedin.com/notifications/', { waitUntil: 'domcontentloaded' });
      await sleep(humanDelay(2000, 5000));
      await humanScroll(page, persona, { depth: 'partial' });
    },
  ];
  const detour = detours[randInt(0, detours.length - 1)];
  console.log('   … taking an organic detour (feed / network / notifications)');
  await detour().catch(() => {});
  await sleep(humanDelay(2000, 5000));
}

module.exports = {
  launchSession, ensureLoggedIn, isAuthenticated, clickGoogleSignIn,
  detectBlock, detectCommercialLimit, detectAccountTier,
  organicDetour, checkGovernor, recordRun, remainingProfileBudget,
  STATE_DIR,
};
