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
const { sleep, humanDelay, randInt, chance } = require('./humanize');

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

  // A stable-but-plausible viewport per profile. Constant across runs for the
  // same profile (a person's monitor does not change daily), different between
  // profiles.
  const viewports = [
    { width: 1440, height: 900 }, { width: 1512, height: 945 },
    { width: 1366, height: 768 }, { width: 1680, height: 1050 },
  ];
  const vpIndex = [...profileName].reduce((a, c) => a + c.charCodeAt(0), 0) % viewports.length;

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // never headless — see the file header
    viewport: viewports[vpIndex],
    locale: 'en-IN',
    timezoneId: config.limits.activeHours.timezone,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
  });

  context.setDefaultTimeout(45000);
  return { context, userDataDir };
}

/**
 * Confirms the profile is logged in. If it is not, it opens the login page and
 * WAITS for a human to sign in by hand (including any 2FA / captcha). It never
 * types credentials. First run is interactive; every run after that is not,
 * because the profile keeps the session cookie.
 */
async function ensureLoggedIn(page, persona, { timeoutMinutes = 10 } = {}) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await sleep(humanDelay(2500, 5000));

  if (!page.url().includes('/login') && !page.url().includes('/checkpoint') && !page.url().includes('/authwall')) {
    console.log('✔ Session already authenticated.');
    return true;
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('  LOG IN BY HAND in the browser window that just opened.');
  console.log('  Complete any 2FA or verification prompt yourself.');
  console.log('  This script will never type or store your password.');
  console.log(`  Waiting up to ${timeoutMinutes} minutes…`);
  console.log('──────────────────────────────────────────────────────────\n');

  const deadline = Date.now() + timeoutMinutes * 60000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const url = page.url();
    if (url.includes('/feed') || url.includes('/in/')) {
      console.log('✔ Logged in. The profile will remember this — no login next run.');
      await sleep(humanDelay(2000, 4000));
      return true;
    }
  }
  throw new Error('Login timed out. Re-run and sign in when the window opens.');
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
    ["You've reached the", 'commercial-use / search limit'],
    ['try again later', 'soft rate limit'],
    ['Please verify', 'verification challenge'],
  ];
  for (const [needle, label] of signals) {
    if (body.includes(needle)) return label;
  }
  return null;
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
  launchSession, ensureLoggedIn, detectBlock, organicDetour,
  checkGovernor, recordRun, remainingProfileBudget,
  STATE_DIR,
};
