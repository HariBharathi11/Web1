# MinMaxHR LinkedIn Lead Engine

Finds HR decision-makers on LinkedIn, validates that their company is actually hiring, scores them against the MinMaxHR ICP rubric, writes everything to a Google Sheet, and **drafts** outreach messages.

> **It never sends anything.** There is no send path in this codebase. `outreach.draftOnly` must be `true` or the run aborts. Sending is a human action taken in the LinkedIn UI by someone who has read the draft.

Read **[SOP.md](./SOP.md)** before the first run — it holds the ICP definition, the detection-avoidance rules, the warm-up schedule, and the daily procedure. This file is setup only.

---

## Install

```bash
cd leadgen
npm install
npx playwright install chromium     # skip if PLAYWRIGHT_BROWSERS_PATH is already set
```

Requires Node 18+ and a desktop session — the browser runs **headed** on purpose (see SOP §3.6).

## First run

```bash
node src/index.js --profile=default --dry-run
```

A Chromium window opens. **Log in by hand**, including any 2FA. The script waits, never types your password, and never stores it. The profile keeps the cookie in `.state/profiles/default/`, so every run after this is non-interactive.

`--dry-run` writes to `output/*.json` instead of Sheets — use it until the leads look right.

### Flags

| Flag | Effect |
|---|---|
| `--profile=<name>` | Which browser identity to use. One per LinkedIn account. |
| `--dry-run` | Skip Sheets; write local JSON only. |
| `--no-careers` | Skip careers-page validation (faster; scores lose the volume signal). |
| `--force` | Override the pacing governor. Read SOP §3.2 before using it. |

---

## Configure

Everything lives in `config.json`. The three you must set:

```jsonc
"product": {
  "trialLink": "https://minmaxhr.com/signup",   // goes into every draft
  "senderName": "your name"
},
"sheets": {
  "spreadsheetId": "1AbC...xyz"                 // from the Sheet's URL
}
```

Then tune to taste: `searches` (ICP queries), `limits` (daily caps — **lower these for a new account**, see SOP §3.3), `scoring` (title regexes and thresholds), `pacing` (delays; `actionDelayMs` is the 2–3s between-actions band).

---

## Google Sheets API auth

Service account — no browser consent, works unattended, and revoking a client's access is one line in the share dialog.

**1. Create a project and enable the API**
- <https://console.cloud.google.com> → new project (e.g. `minmaxhr-leadgen`)
- APIs & Services → Library → search **Google Sheets API** → **Enable**

**2. Create a service account**
- APIs & Services → Credentials → **Create credentials** → **Service account**
- Name it `leadgen-writer`. Skip the optional role and access steps — permission comes from sharing the Sheet, not from an IAM role.

**3. Download the key**
- Open the service account → **Keys** → **Add key** → **Create new key** → **JSON**
- Save it as `leadgen/credentials/service-account.json`

```bash
mkdir -p credentials
mv ~/Downloads/minmaxhr-leadgen-*.json credentials/service-account.json
```

`credentials/` and `.state/` are gitignored. Keep it that way — that file is a live credential.

**4. Share the Sheet with the service account**
- Create a Google Sheet (tabs are created automatically — don't make them by hand)
- Copy `client_email` from the JSON (looks like `leadgen-writer@minmaxhr-leadgen.iam.gserviceaccount.com`)
- In the Sheet: **Share** → paste that address → **Editor** → Share

Skipping this step is the cause of ~90% of "it can't see my sheet" problems. The service account is a separate identity; your own access to the Sheet grants it nothing.

**5. Put the spreadsheet ID in config**

From `https://docs.google.com/spreadsheets/d/`**`1AbC...xyz`**`/edit`, the bold part is the ID → `sheets.spreadsheetId`.

**6. Verify**

```bash
node -e "require('./src/sheets').getClient().then(()=>console.log('✔ Sheets auth OK'))"
```

Alternative: set `GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/key.json` in `.env` to keep the key outside the repo.

---

## What lands in the Sheet

Three tabs, created and formatted on first write.

**Leads** — one row per person, deduped on LinkedIn URL. Re-scraping updates the row in place, so the sheet is a running pipeline, not a snapshot. Includes the full **Scoring Rationale** — every signal that produced the number, including the ones worth zero.

**Message Drafts** — top 10 by score, with `Status` = `DRAFT — review then send by hand` or `WITHHELD`, plus two empty columns (`Sent By Human?`, `Sent On`) for you to fill in after sending. Nothing writes to those columns automatically.

**Run Log** — one row per run: persona, counts, duration, outcome. This is how you spot a run that got throttled.

---

## Scoring

| Band | Score | Who |
|---|---|---|
| **A — Priority** | 90–100 | CHRO / VP HR at a company with 100+ validated hires/quarter |
| **B — Qualified** | 75–89 | HR Manager / TA Lead at mid-market with a hiring signal |
| **C — Not a priority** | <75 | Not contacted |

Built from four components — seniority (0–55), validated hiring volume (0–30), segment fit (0–10), geography (0–5) — with band guards so the top band can only be reached by a Tier-1 title at a genuinely high-volume employer, and the priority band requires a validated hiring signal. Every score carries its reasoning. Full logic and rationale: `src/score.js`.

---

## Files

```
config.json          all tuning — searches, caps, pacing, scoring, template
src/index.js         the run: governor → login → search → visit → validate → score → draft → write
src/humanize.js      behavioural layer — delays, Bézier mouse, scrolling, typing, ordering
src/session.js       persistent profile, manual login, block detection, usage governor
src/scrape.js        search + profile extraction (defensive selectors)
src/careers.js       resolves company → website → careers page → counts live openings
src/score.js         the ICP rubric, with written reasoning per signal
src/messages.js      draft builder. DRAFTS ONLY — no send path exists
src/sheets.js        Google Sheets output, dedupe + in-place update
.state/              browser profiles + usage counters (gitignored)
output/              local JSON per run (gitignored)
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Run blocked by the pacing governor` | Working as designed — outside hours, weekend, cooldown, or daily cap. SOP §3.2. |
| `BLOCKED: …` mid-run | LinkedIn flagged the session. **Stop for the day** and follow SOP §3.4. |
| 0 cards harvested | LinkedIn changed its DOM. Fix `extractResultCards` in `src/scrape.js` — it's anchored to `/in/` links, so it degrades rather than crashing. |
| Many drafts `WITHHELD` | Careers validation isn't resolving websites. Check the `Website` and `Careers URL` columns. Working as designed — better withheld than wrong. |
| `service-account key not found` | Step 3 above. |
| Sheets 403 | Step 4 above — share the Sheet with `client_email`. |
