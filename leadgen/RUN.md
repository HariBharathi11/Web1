# Daily Runbook

Everything you actually type, in order. First-time setup is §1 (about 20 minutes, once). After that the daily loop is §3 and takes about 15 minutes of machine time and 45 minutes of your time.

---

## 1. One-time setup

### 1.1 Export your connections — do this first

> LinkedIn → **Settings & Privacy** → **Data Privacy** → **Get a copy of your data** → tick **Connections** → **Request archive**

The email arrives in a few minutes. Unzip it, and put `Connections.csv` here:

```
leadgen/input/Connections.csv
```

This is the single highest-value action in the whole system — ~2,000 warm contacts, no automation, no risk. Everything else is secondary to it.

### 1.2 Install

```bash
cd leadgen
npm install
npx playwright install msedge      # teaches Playwright where Edge is
```

Edge must already be installed (it is, on Windows). Playwright drives your real Edge, not a bundled browser.

### 1.3 Google Sheets access

Full walkthrough in [README.md](./README.md#google-sheets-api-auth). The short version:

1. <https://console.cloud.google.com> → new project → enable **Google Sheets API**
2. Credentials → **Create credentials** → **Service account** → name it `leadgen-writer`
3. Keys → **Add key** → **JSON** → save as `leadgen/credentials/service-account.json`
4. Copy `client_email` from that file, then in your Sheet: **Share** → paste it → **Editor**

**Also change your Sheet from "anyone with the link" to "Restricted".** Right now anyone holding that URL can read your entire lead database.

### 1.4 Confirm everything is wired

```bash
npm run verify
```

Fix anything marked ✖ before going further. It checks Node, Edge, your config, the connections file, the credentials, and whether the service account can actually reach your Sheet.

### 1.5 Sign in to LinkedIn, once

```bash
npm run cold
```

Edge opens. It navigates to LinkedIn and clicks **Continue with Google** for you. **You** pick your Google account and complete 2FA — the script never types your email, password, or code, and never chooses an account.

Once you are in, the Edge profile at `.state/profiles/default/` keeps the session. You will not be asked again.

---

## 2. What each command does

| Command | Browser? | LinkedIn? | Time | What it does |
|---|---|---|---|---|
| `npm run verify` | no | no | 10s | Preflight |
| `npm run network` | no | **no** | 2s | What is in your network — segments, seniority, gaps |
| `npm run profile` | Edge | yes (1 view) | ~2 min | Audit your own profile for conversions |
| `npm run engage` | Edge | yes (low) | ~5 min | Harvest engagers from your own posts |
| `npm run warm` | no | no | 2s | Import connections → companies + people |
| `npm run enrich` | Edge (background) | **no** | ~3s/company | Company sites: careers page, openings, ATS, region, socials |
| `npm run score` | no | no | 1s | Re-score every account through the Venn |
| `npm run draft` | no | no | 1s | Build drafts, schedule touch sequences |
| `npm run sync` | no | no | 5s | Push everything to Google Sheets |
| `npm run daily` | Edge | **no** | ~5 min | All of the above, in order |
| `npm run cold` | Edge | **yes** | ~15 min | Cold search. 10 profiles/day. Optional |
| `npm run revenue` | no | no | 1s | Pipeline vs the ₹1,00,000 target |

**Only `cold` touches LinkedIn.** Everything else is a file read or a public website — no account risk, run it as often as you like.

---

## 3. The daily loop

### Morning — 2 minutes of typing

```bash
cd leadgen
npm run daily
```

That imports, enriches ~20 companies, re-scores, drafts, and syncs to your Sheet. Watch the "Top accounts" table it prints; if Band A is empty, run `npm run enrich --limit=50` to push more companies through validation.

### Afternoon — the part that earns the money

Open your Sheet → **Daily Actions** tab. It is ordered by account priority. Work down it:

1. **`view` steps** — open the profile, look, close. Seconds each.
2. **`engage` steps** — react to or comment on a recent post. Skip if they have not posted.
3. **`message` steps** — open **Message Drafts**, read the draft, check the company name and role count against the Careers URL in the **Companies** tab, then send it yourself from LinkedIn.

Mark `Done? = y` as you go, and fill `Sent On` in Message Drafts.

**Send at most 15–20 a day**, spread out. That ceiling is the real constraint on the whole operation — see §5.

### Weekly — the two that compound

```bash
npm run profile     # Monday. Re-audit after you make changes.
npm run engage      # after any post that got traction
```

`profile` is the highest-leverage thing in this repo that is not the connections
export. Every recipient who considers replying clicks your profile first, so a
fix there improves every message you will ever send — including ones already
sitting unread.

`engage` reads the reactions on your own posts and pulls ICP engagers into the
pipeline with a `post_engagement` signal. Those people raised their hand in
public: they score **+15 Access and +12 Timing** and get a dedicated opener
instead of a cold one. Run it the day after a post lands.

### Optional, once or twice a day

```bash
npm run cold
```

Tops up segments your network does not cover. Skip it whenever you like; it contributes about a quarter of the pipeline.

### Friday — 15 minutes

```bash
npm run revenue
```

Then update your real reply/trial/paid rates in `config.json → revenue` and re-run it. Check whether Band A is actually out-converting Band B; if not, the rubric needs adjusting, not the message.

---

## 4. Running it from Claude Code

A slash command is installed at `.claude/commands/leads.md`. In Claude Code, just type:

```
/leads
```

It runs the daily pipeline, reads back the top accounts and any drafts, and tells you what is worth your attention. You can also say things like *"run enrich on 50 more companies"* or *"why did Gulf Talent score 81?"* — the reasoning for every score is stored per axis and can be read straight out of the database.

---

## 5. Scheduling it — only after a week of clean manual runs

Do not schedule until you have run it by hand for a week and the numbers look right. A scheduled job that produces bad drafts just produces them faster.

When you are ready, schedule **`daily` only** — never `cold`. The safe lane can run unattended; the LinkedIn lane should not.

### Windows Task Scheduler

1. Task Scheduler → **Create Task** (not Basic Task)
2. General → **Run whether user is logged on or not** unticked (Edge needs your session)
3. Triggers → **New** → Daily → **10:07** — deliberately not 10:00. A job that fires at exactly the top of the hour every day is its own pattern.
4. Actions → **New** → Start a program:
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `--no-warnings src/index.js daily`
   - Start in: `C:\path\to\Web1\leadgen`
5. Conditions → untick *Start only if on AC power*

### macOS / Linux

```bash
crontab -e
# 10:07 on weekdays — odd minute on purpose
7 10 * * 1-5 cd /path/to/Web1/leadgen && /usr/bin/node --no-warnings src/index.js daily >> .state/cron.log 2>&1
```

The governor enforces the caps whether a human or cron started the run.

---

## 5a. Optimising the account for conversions

Run `npm run network` first — it needs no browser and answers whether your
network can even support the target. Then `npm run profile`.

The profile rubric is scored for **outbound conversion**, not general profile
advice. It weights what a CHRO actually sees in the eight seconds after clicking
through from your message:

| Element | Weight | Why |
|---|---|---|
| Headline | 20 | Renders next to every message and comment you send |
| Featured | 20 | The only place a profile can hold a *direct conversion path* |
| About | 15 | Only the first two lines are read before "see more" |
| Recent activity | 15 | An empty feed quietly discredits you |
| Banner | 10 | Free advertising on every profile view |
| CTA button | 8 | Sits under the headline — first clickable thing |
| Social proof | 7 | Recommendations from HR/staffing people specifically |
| Basics | 5 | Photo, reach |

It prints replacement headline and About copy. Every claim in that copy traces to
the buyer's guide — a test asserts it never says "SOC 2 certified", never
guarantees anything, and never implies MinMaxHR is an ATS.

**The audit reads and reports. It never edits your profile.** Same posture as the
message drafts: the tool prepares, you decide.

## 6. When something looks wrong

| What you see | What it means |
|---|---|
| Everything Band C, timing 0 | Enrichment has not run. `npm run enrich` then `npm run score`. Working as designed — the Venn will not promote an account whose hiring is unverified. |
| `Commercial Use Limit reached` | A monthly **search quota**, not a restriction. Your account is fine. Keep working the warm lane; it does not consume the quota. |
| `BLOCKED: …` | Stop for the day. SOP §5.6. Lanes A and B stay open. |
| Many drafts `WITHHELD` | Enrichment could not verify a volume claim. Better withheld than wrong — check the Companies tab for that company. |
| `Could not launch Microsoft Edge` | `npx playwright install msedge`, or set `browser.channel` to `null` in `config.json` to use bundled Chromium. |
| Sheets 403 | Share the Sheet with the service account's `client_email` as Editor. |
| Sign-in loops | Delete `.state/profiles/default/` and run `npm run profile` again to sign in fresh. |
| `npm run engage` finds no posts | You have not posted recently. This lane converts posts into leads, so it produces nothing until there are posts to harvest. |
| Profile audit fields blank | LinkedIn changed its DOM. The extractor distinguishes "missing" from "unreadable" — check `output/profile-audit.json` for what it actually saw. |

---

## 7. The number this is all pointed at

```bash
npm run revenue
```

Target ₹1,00,000/month. The realistic mix is **1 Enterprise + 7 Growth = ₹1,09,993**, reached in about 3 months at 4 new clients a month.

That needs roughly **134 warm sends a month — about 7 a working day**, comfortably inside the 20/day ceiling. Cold-only would need 16/day, which is over the ceiling *and* over the safe scraping rate. That gap is the whole argument for the warm-first design.

One thing to keep in view: MinMaxHR plans are **one-time 30-day purchases with no auto-renewal**. That is a good promise to make to a buyer, but it means this revenue is re-won every month rather than recurring. At a 70% repeat rate you must replace **3 clients every month just to stand still**. Track repeat purchase as closely as you track new sales — it is the number that decides whether ₹1,00,000 holds or slides back.
