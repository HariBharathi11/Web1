# MinMaxHR Revenue Engine

An account-based LinkedIn pipeline for MinMaxHR: sources leads warm-network-first, maps companies to the ICP people inside them, validates that they are actually hiring, scores every account on **Fit × Access × Timing**, renders the pipeline to Google Sheets, and **drafts** outreach.

> **It never sends anything.** There is no send path in this codebase — a test asserts that structurally. `outreach.draftOnly` must be `true` or the run aborts. Sending is a human action, taken in the LinkedIn UI, by someone who has read the draft.

Read **[SOP.md](./SOP.md)** before the first run. This file is setup only.

---

## Start here — the five-minute move that matters most

Before installing anything:

> LinkedIn → **Settings & Privacy → Data Privacy → Get a copy of your data → Connections → Request archive**

Save the CSV to `leadgen/input/Connections.csv`. That single download is worth more than everything else in this repository: ~2,000 first-degree contacts, no automation, no rate limit, no detection surface. See SOP §1.

## Install

```bash
cd leadgen
npm install
npx playwright install chromium    # skip if PLAYWRIGHT_BROWSERS_PATH is set
```

Node **22.5+** (uses the built-in `node:sqlite` — no native modules to compile). Lane C runs a **headed** browser on purpose, so it needs a desktop session; Lanes A and B do not.

## Run

```bash
npm run daily      # warm → enrich → score → draft → sync   ← the everyday command
```

Or one lane at a time:

| Command | Touches LinkedIn? | What it does |
|---|---|---|
| `npm run warm` | **No** | Imports Connections.csv → companies + people |
| `npm run enrich` | **No** | Company websites: domain, region, careers page, openings, ATS, socials |
| `npm run score` | No | Re-scores every account through the Venn |
| `npm run draft` | No | Builds drafts, schedules touch sequences |
| `npm run cold` | **Yes** | Cold search — the risky lane. 10 profiles/day, optional |
| `npm run sync` | No | Renders the pipeline to Google Sheets |
| `npm test` | No | 35 tests |

Flags: `--profile=<name>` (one per LinkedIn account) · `--dry-run` (skip Sheets) · `--limit=<n>` · `--force` (override the governor — read SOP §5.2 first).

**First `npm run cold`:** a Chromium window opens. Log in by hand, including 2FA. The script waits, never types your password, never stores it. The profile keeps the cookie in `.state/profiles/<name>/`.

---

## Configure

Everything is in `config.json`. Already set for you: trial link, sign-off, spreadsheet ID.

Worth tuning: `regions` (multipliers), `venn.weights` and band thresholds, `lanes.*.profileBudget`, `limits` (lower for a new account — SOP §5.5), `scoring.tier1TitleRegex` / `tier2TitleRegex`.

---

## Google Sheets API auth

Service account — no browser consent, works unattended, and revoking a client's access is one line in the share dialog.

**1. Enable the API**
<https://console.cloud.google.com> → new project → APIs & Services → Library → **Google Sheets API** → **Enable**

**2. Create a service account**
Credentials → **Create credentials** → **Service account** → name it `leadgen-writer`. Skip the optional role steps — permission comes from sharing the Sheet, not from IAM.

**3. Download the key**
Open it → **Keys** → **Add key** → **Create new key** → **JSON**

```bash
mkdir -p credentials
mv ~/Downloads/*.json credentials/service-account.json
```

`credentials/`, `.state/` and `input/` are gitignored. Keep it that way — that file is a live credential and `input/` holds your network.

**4. Share the Sheet with the service account**
Copy `client_email` from the JSON (`leadgen-writer@….iam.gserviceaccount.com`), then in the Sheet: **Share → paste → Editor → Share**.

This is the step people miss. The service account is a separate identity; your own access grants it nothing.

> **Your sheet is currently shared by link.** That means anyone holding the URL can read — and if it is link-editable, edit — your entire lead database. Restrict it to "Restricted" and share it with the service account instead.

**5. Verify**

```bash
node -e "require('./src/render/sheets').getClient().then(()=>console.log('✔ Sheets auth OK'))"
```

Alternative: set `GOOGLE_APPLICATION_CREDENTIALS=/abs/path/key.json` in `.env` to keep the key outside the repo.

---

## What lands in the Sheet

Six tabs, rebuilt from the database on every sync. The DB is the store of record — the sheet can be wiped or reformatted without losing pipeline state.

| Tab | What it is |
|---|---|
| **Accounts** | The scoreboard. Priority, band, fit/access/timing, best route in, blockers, and the written reasoning behind all three axes |
| **Companies** | Enrichment: domain, region, size, live openings, ATS, careers URL, and social handles |
| **People** | The contact map — who, what seniority, which company, connection degree |
| **Message Drafts** | What to send and to whom, plus `Sent By Human?` / `Sent On` — **columns only you ever fill in** |
| **Daily Actions** | Today's worklist: view → engage → message, ordered by account priority |
| **Run Log** | One row per run |

---

## Scoring — the Venn

```
priority = fit^0.40 × access^0.35 × timing^0.25      (weighted geometric mean)
```

**Geometric, not additive, and that is the whole design.** A zero on any axis zeroes the account: a perfect-fit enterprise you cannot reach scores nothing, and so does a warm first-degree CHRO at a company that is not hiring. An additive score would let two strong axes carry a dead one, and you would spend your 20 daily messages on leads that only look good on one dimension.

Bands: **A ≥ 75** · **B 60–74** · **C < 60** (never contacted).

US and EU **enterprises** are automatically downgraded ×0.45 with a visible `SOC 2 not yet certified` blocker — the buyer's guide is explicit that this is a real non-fit today. In those regions, target staffing agencies instead. Full logic and reasoning: `src/venn.js`.

---

## Files

```
config.json              regions, multipliers, lane budgets, caps, pacing, ICP regexes
src/index.js             lane orchestration
src/db.js                SQLite store — companies, people, signals, accounts, drafts, touches
src/venn.js              Fit × Access × Timing, region multipliers, blockers
src/score.js             person classification (tier1/tier2/tier3)
src/lanes/warm.js        Connections.csv → pipeline. No automation
src/enrich/company.js    domain, region, size, socials, careers page
src/careers.js           counts live openings; detects ATS embeds
src/signals.js           timing evidence, with sources
src/playbook.js          20 sales angles (4 segments × 5 situations). Zero LLM calls
src/messages.js          draft builder. DRAFTS ONLY — no send path exists
src/sequence.js          view → engage → message scheduler (human-executed)
src/session.js           persistent profile, manual login, block + CUL + tier detection, governor
src/scrape.js            cold search extraction
src/humanize.js          behavioural layer — delays, Bézier mouse, scrolling, typing
src/render/sheets.js     DB → six-tab Sheet view
.state/                  pipeline.db + browser profiles + usage counters (gitignored)
input/                   your Connections.csv (gitignored)
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `No connections export at …` | Do the export in "Start here" above. |
| Everything scores Band C with timing 0 | Enrichment has not run yet. `npm run enrich` then `npm run score`. Working as designed — the Venn will not promote an account whose hiring is unverified. |
| `Run blocked by the pacing governor` | Lane C only, working as designed. Lanes A and B are unaffected — keep going. |
| `Commercial Use Limit reached` | A monthly search quota, not a restriction. Account is fine. Work the warm lane; it does not consume the quota. |
| `BLOCKED: …` | Stop for the day, follow SOP §5.6. |
| Many drafts `WITHHELD` | Enrichment could not verify a volume claim. Working as designed — better withheld than wrong. Check the Companies tab. |
| Sheets 403 | Share the Sheet with the service account's `client_email`. |
| 0 cards in cold lane | LinkedIn changed its DOM. Fix `extractResultCards` in `src/scrape.js` — it is anchored to `/in/` links so it degrades rather than crashing. |
