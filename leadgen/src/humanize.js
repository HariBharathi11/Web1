/**
 * humanize.js — behavioural layer.
 *
 * The thing that gets accounts flagged is not "a browser" — it is a *rhythm*:
 * identical gaps between actions, linear top-to-bottom scrolls, zero idle time,
 * perfect click accuracy, and a session that never gets bored. Everything here
 * exists to make the session's timing distribution look like a person who is
 * reading, not a loop that is harvesting.
 */

// ---------------------------------------------------------------------------
// Randomness primitives
// ---------------------------------------------------------------------------

/** Uniform int in [min, max]. */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Uniform float in [min, max]. */
function rand(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * Log-normal-ish delay. Human inter-action gaps are NOT uniform — they cluster
 * near a mode with a long right tail (the occasional "went to get coffee").
 * A uniform random(2000,3000) is itself a detectable signature: real users
 * never produce a flat distribution. This skews the draw so most gaps sit near
 * the low end while a minority stretch well past `max`.
 */
function humanDelay(min, max) {
  const base = min + (max - min) * Math.pow(Math.random(), 1.6);
  const jitter = 1 + (Math.random() - 0.5) * 0.35;
  const tail = Math.random() < 0.07 ? rand(1.8, 4.2) : 1; // rare long pause
  return Math.round(base * jitter * tail);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function chance(p) {
  return Math.random() < p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Session personality
// ---------------------------------------------------------------------------

/**
 * Each run picks a "mood" that shifts every timing multiplier for the whole
 * session. Two runs on the same account therefore never share a fingerprint of
 * pace — which matters more than any single delay value, because detection is
 * run-over-run correlation, not one page view.
 */
function newPersona() {
  const moods = [
    { name: 'skimming', speed: 0.75, dwell: 0.7, scrollBursts: [3, 6], readRate: 0.35 },
    { name: 'steady', speed: 1.0, dwell: 1.0, scrollBursts: [2, 5], readRate: 0.55 },
    { name: 'thorough', speed: 1.35, dwell: 1.6, scrollBursts: [4, 9], readRate: 0.8 },
    { name: 'distracted', speed: 1.15, dwell: 2.1, scrollBursts: [1, 4], readRate: 0.45 },
  ];
  const mood = pick(moods);
  return {
    ...mood,
    // Per-session scroll signature: wheel deltas differ between people/devices.
    wheelStep: randInt(90, 260),
    // Some people use the keyboard to scroll, some never do.
    usesKeyboardScroll: chance(0.4),
    startedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

/** The standard between-actions gap (config default 2–3s), persona-scaled. */
async function pause(persona, range) {
  const [min, max] = range;
  await sleep(Math.round(humanDelay(min, max) * persona.speed));
}

/** A longer "reading this page" dwell. */
async function dwell(persona, range) {
  const [min, max] = range;
  await sleep(Math.round(humanDelay(min, max) * persona.dwell));
}

/** Periodic step-away break so the session has gaps, not a flat throughput. */
async function longBreak(persona, range) {
  const [min, max] = range;
  const ms = Math.round(humanDelay(min, max) * persona.dwell);
  console.log(`   … stepping away for ${Math.round(ms / 1000)}s`);
  await sleep(ms);
}

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

/**
 * Cubic-Bézier mouse path with per-step jitter. A straight A→B teleport (what
 * page.click does by default) has no analogue in human input.
 */
async function moveMouse(page, x, y, persona) {
  const steps = randInt(14, 30);
  const start = page.__lastMouse || { x: randInt(100, 900), y: randInt(100, 600) };

  // Two control points offset perpendicular-ish to the travel line => an arc.
  const c1 = { x: start.x + (x - start.x) * 0.3 + rand(-90, 90), y: start.y + (y - start.y) * 0.3 + rand(-90, 90) };
  const c2 = { x: start.x + (x - start.x) * 0.7 + rand(-90, 90), y: start.y + (y - start.y) * 0.7 + rand(-90, 90) };

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const px = u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * x;
    const py = u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * y;
    await page.mouse.move(px + rand(-1.5, 1.5), py + rand(-1.5, 1.5));
    // Ease-in-out: slow at both ends, quick through the middle.
    await sleep(rand(4, 16) * (1 + Math.abs(0.5 - t)) * persona.speed);
  }
  page.__lastMouse = { x, y };
}

/** Move to an element's box (off-centre) and click it. */
async function humanClick(page, locator, persona) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element not visible for click');
  // Humans do not click dead centre.
  const x = box.x + box.width * rand(0.25, 0.75);
  const y = box.y + box.height * rand(0.3, 0.7);
  await moveMouse(page, x, y, persona);
  await sleep(humanDelay(60, 220));
  await page.mouse.down();
  await sleep(randInt(45, 130)); // press duration
  await page.mouse.up();
}

/** Aimless cursor drift while "reading". */
async function idleMouseDrift(page, persona) {
  const moves = randInt(1, 3);
  for (let i = 0; i < moves; i++) {
    const vp = page.viewportSize() || { width: 1440, height: 900 };
    await moveMouse(page, randInt(60, vp.width - 60), randInt(80, vp.height - 80), persona);
    await sleep(humanDelay(300, 1500));
  }
}

// ---------------------------------------------------------------------------
// Scrolling — the highest-signal behaviour
// ---------------------------------------------------------------------------

/**
 * Reads a page the way a person does: bursts of wheel events of varying size,
 * pauses to read, frequent *upward* corrections (scrolling back to re-read
 * something), occasional overshoot, and sometimes keyboard scrolling instead.
 *
 * Deliberately non-monotonic — a strictly increasing scrollY with even deltas
 * is one of the cleanest automation tells there is.
 */
async function humanScroll(page, persona, { depth = 'full' } = {}) {
  const [minBursts, maxBursts] = persona.scrollBursts;
  const bursts = randInt(minBursts, maxBursts) * (depth === 'partial' ? 1 : 2);

  for (let i = 0; i < bursts; i++) {
    // Backtrack: scroll up to re-read. Real reading is not one-directional.
    const goingUp = chance(0.25);
    const ticks = goingUp ? randInt(1, 3) : randInt(2, 7);

    if (persona.usesKeyboardScroll && chance(0.2)) {
      const key = goingUp ? 'PageUp' : 'PageDown';
      await page.keyboard.press(key);
    } else {
      for (let t = 0; t < ticks; t++) {
        const delta = persona.wheelStep * rand(0.55, 1.5) * (goingUp ? -1 : 1);
        await page.mouse.wheel(0, delta);
        await sleep(humanDelay(35, 160)); // intra-burst tick gap
      }
    }

    // Pause to "read" — this is where most of the session's time should go.
    if (chance(persona.readRate)) {
      await sleep(humanDelay(900, 4200) * persona.dwell);
      if (chance(0.3)) await idleMouseDrift(page, persona);
    } else {
      await sleep(humanDelay(250, 1100) * persona.dwell);
    }

    // Overshoot-and-correct.
    if (chance(0.15)) {
      await page.mouse.wheel(0, -persona.wheelStep * rand(0.8, 2.2));
      await sleep(humanDelay(200, 800));
    }
  }
}

/**
 * Fast scroll for pages where nobody is watching the rhythm.
 *
 * humanScroll spends most of its time *pausing to read*, which is exactly right
 * on LinkedIn and pure waste on a company's own careers page. Public marketing
 * sites do not run behavioural detection, and enrichment has to get through
 * hundreds of them — at human pace that is hours per run instead of minutes.
 *
 * Still scrolls properly (lazy-loaded job lists need it), just without the
 * reading pauses.
 */
async function quickScroll(page, { passes = 4 } = {}) {
  for (let i = 0; i < passes; i++) {
    await page.mouse.wheel(0, 1200 + Math.random() * 800);
    await sleep(randInt(60, 180));
  }
  // One trip back up, so anything that lazy-loads on upward scroll also fires.
  await page.mouse.wheel(0, -2000);
  await sleep(randInt(80, 200));
}

/** Scroll an element into view organically rather than via scrollIntoView(). */
async function scrollToElement(page, locator, persona) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const box = await locator.boundingBox().catch(() => null);
    const vp = page.viewportSize() || { width: 1440, height: 900 };
    if (box && box.y > 100 && box.y < vp.height - 150) return true;
    const dir = box && box.y < 100 ? -1 : 1;
    await page.mouse.wheel(0, dir * persona.wheelStep * rand(0.8, 1.8));
    await sleep(humanDelay(90, 320));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

/** Types with variable per-key delay, occasional typo + backspace correction. */
async function humanType(page, locator, text, persona, delayRange = [90, 260]) {
  await humanClick(page, locator, persona);
  await sleep(humanDelay(200, 700));
  for (const ch of text) {
    if (chance(0.03)) {
      // Typo, noticed a beat later, corrected.
      await page.keyboard.type(pick('abcdefghijklmnopqrstuvwxyz'.split('')));
      await sleep(humanDelay(180, 520));
      await page.keyboard.press('Backspace');
      await sleep(humanDelay(90, 260));
    }
    await page.keyboard.type(ch);
    let d = humanDelay(delayRange[0], delayRange[1]) * persona.speed;
    if (ch === ' ') d *= 1.4; // word boundaries are slower
    await sleep(d);
  }
}

// ---------------------------------------------------------------------------
// Order & noise
// ---------------------------------------------------------------------------

/** Fisher–Yates. Never process a result list in DOM order twice in a row. */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Partial shuffle: mostly in order (a person does read top-down) but with
 * local swaps and skips, so the visit sequence never equals the result rank.
 */
function humanOrder(arr, { skipRate = 0.12 } = {}) {
  const kept = arr.filter(() => !chance(skipRate));
  for (let i = 0; i < kept.length - 1; i++) {
    if (chance(0.3)) [kept[i], kept[i + 1]] = [kept[i + 1], kept[i]];
  }
  return kept;
}

module.exports = {
  randInt, rand, humanDelay, pick, chance, sleep,
  newPersona, pause, dwell, longBreak,
  moveMouse, humanClick, idleMouseDrift,
  humanScroll, quickScroll, scrollToElement,
  humanType, shuffle, humanOrder,
};
