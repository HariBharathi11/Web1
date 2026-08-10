# Standard Operating Procedure — MinMaxHR LinkedIn Lead Engine

**Objective:** 20 paying MinMaxHR clients.
**Absolute rule:** this system drafts messages. It never sends one. Sending is a human action.

---

## 1. The maths behind "20 paying clients"

Work backwards, because it changes how many leads you actually need.

| Stage | Rate | Volume needed |
|---|---|---|
| Paying clients | — | **20** |
| Free-tier trials that convert | 25% | 80 trials |
| Replies that start a trial | 40% | 200 replies |
| Messages sent that get a reply | 12% | ~1,650 sends |
| Band A/B leads worth messaging | 45% of scored | ~3,700 leads scored |

Those rates are planning assumptions, not measured facts — replace each one with your own number after the first 200 sends. The point of the table is the shape: **you need roughly 3,500–4,000 scored leads, not 200.** At the safe rate this system runs (20 profiles/run, 2 runs/day, 5 days/week), that is ~200 leads a week, so **roughly 18–20 weeks on one account.**

Three ways to compress it, in order of how much I'd trust them:

1. **Run several profiles.** Each client or teammate who logs in their own account is a separate `--profile`, each with its own independent budget. Four accounts ≈ 5 weeks instead of 20.
2. **Raise conversion, not volume.** Moving reply rate from 12% to 20% removes 650 sends. The free-tier offer in the buyer's guide is the strongest lever here — it is genuinely free, and the retrospective test ("rank a role you already filled, compare to who you actually chose") is a better hook than any subject line.
3. **Widen the top of the funnel off LinkedIn.** Job boards, company careers pages, and funding announcements all identify high-volume hirers without touching LinkedIn at all. That is the roadmap item in §7.

Do not compress it by raising the daily caps. That trades a 20-week campaign for a restricted account and a 0-week campaign.

---

## 2. ICP definition

### Tier 1 — score 90–100. Draft first.
- **Titles:** CHRO, Chief People Officer, VP HR, Head of HR / People / Talent
- **Company:** 100+ validated hires per quarter (≈40+ live openings on the careers page)
- **Geography:** India — matches Mumbai data residency and ₹ pricing
- **Why they buy:** they own the hiring KPI. Time-to-shortlist is on their board slide.
- **Lead with:** defensibility and the audit trail. This buyer has been asked "why was this candidate dropped?" and had no answer.

### Tier 2 — score 75–89. Draft second.
- **Titles:** HR Manager, TA Lead, Recruitment Manager, Head of Talent, People Ops Lead
- **Company:** mid-market with a real hiring signal (8+ live openings, or an ATS in place)
- **Why they buy:** they personally read the resume pile. This is their weekend back.
- **Lead with:** recruiter hours. 40+ hours a month per recruiter reading documents.

### Highest-fit segment of all — staffing / RPO / recruitment agencies
Scored with a +10 bonus, and worth pursuing ahead of headcount-matched enterprises. They win or lose mandates on shortlist speed, so screening time is **revenue**, not overhead. They also buy faster, because there is no internal-tooling committee.

### Explicitly not a fit — do not draft, even at a high score
- Teams who want an ATS (MinMaxHR is not one, and pretending otherwise loses the second call)
- Anyone who wants humans removed from hiring (deliberately not built)
- Anyone needing a sourcing agency (this ranks applicants you already have)
- Procurement with a hard SOC 2 gate today (controls exist, certificate does not)

Naming the poor fit up front is the same posture the buyer's guide takes, and it is why that document is credible. Keep the outreach consistent with it.

---

## 3. Detection avoidance — the actual operating rules

Understand what is being detected. It is not "a browser" — it is a **rhythm**. Platforms score sessions on the *distribution* of behaviour over time: gap variance between actions, scroll direction changes, idle periods, session length, day-over-day consistency, and volume relative to your account's own history. Nothing here defeats detection by disguise. It works by not producing an inhuman pattern in the first place.

### 3.1 What is built in (automatic)

| Behaviour | Why |
|---|---|
| **Real headed Chromium, persistent profile** | Headless is trivially fingerprinted. A real profile with real cookies has nothing to disguise. |
| **Manual login, once, by hand** | Scripted logins are the single most-flagged event. Password is never typed or stored by the script. |
| **Log-normal delays, not uniform** | A flat `random(2000,3000)` is *itself* a signature — real gaps cluster with a long tail. Delays sit in the 2–3s band with a 7% chance of a much longer pause. |
| **Session persona** | Every run picks a mood (skimming / steady / thorough / distracted) that scales every timing multiplier. Two runs never share a pace fingerprint. |
| **Bézier mouse paths, off-centre clicks** | Straight-line cursor jumps and dead-centre clicks have no human analogue. |
| **Non-monotonic scrolling** | 25% of scroll bursts go **upward** (re-reading), with overshoot-and-correct, varying wheel deltas, and occasional keyboard scrolling. A strictly increasing scrollY with even deltas is the cleanest tell there is. |
| **Search via the real search box** | Typed character-by-character with occasional typo + backspace. Deep-linking to `/search/results/people/?keywords=` with no referrer is a navigation pattern users don't produce. |
| **Randomised visit order** | Results are visited in *near*-rank order with local swaps and a 15% skip rate, never in exact score order. |
| **12% abandon rate** | Some profiles are opened and left. Perfect follow-through is not human. |
| **Organic detours** | Between profile batches the session visits the feed / network / notifications. A session that is 100% extraction and 0% consumption is anomalous on its face. |
| **Long breaks** | 45s–150s step-aways every 5–8 profiles. Flat throughput for 40 minutes is not a person. |
| **Randomised search order** | Which of the four ICP searches runs first rotates every run. |
| **Separate cookie-less context for company sites** | Careers-page traffic never touches the LinkedIn session. |

### 3.2 The governor — the most important part

`src/session.js` refuses to start a run that would look mechanical:

- **Working hours only** — 09:00–20:00 IST. A sourcing session at 03:00 is the loudest signal you can send.
- **Weekdays only** — real recruiters are not sourcing on Sunday.
- **Max 2 runs/day**, with a **3-hour cooldown** between them.
- **Hard cap 40 profile views/day**, **20 per run**. Enforced across runs via `.state/usage.json`, so `--force` on run three still cannot exceed the daily cap without editing config.

These numbers are deliberately below what the account could get away with. The campaign takes 20 weeks either way; a restricted account takes it to never.

### 3.3 Warm-up schedule — mandatory for a new or dormant account

A cold account that suddenly views 20 profiles a day is the pattern. Ramp:

| Days | `maxProfileVisitsPerRun` | `maxRunsPerDay` |
|---|---|---|
| 1–3 | 5 | 1 |
| 4–7 | 8 | 1 |
| 8–14 | 12 | 2 |
| 15+ | 20 | 2 |

During warm-up, also use the account normally by hand — post, comment, accept connections. An account with organic activity absorbs far more automation than one that only ever runs the script.

### 3.4 Stop conditions — non-negotiable

The script aborts on any of: checkpoint / auth wall, "We've restricted", "unusual activity", "You've reached the…", "Please verify". When that fires:

1. **Stop. Do not re-run today.** Pushing through a soft warning is how it becomes a hard restriction.
2. Open LinkedIn manually in that same profile. Browse normally for a day — feed, a few posts, a comment.
3. Resume tomorrow at **half** the previous limits, and ramp back over a week.
4. If a checkpoint appeared, complete it by hand before anything else.

### 3.5 Client-deployment rules

When a client runs this on their own machine and account:

- Each account gets its own `--profile=<name>` — separate cookie jar, separate viewport, separate usage counter. No bleed.
- **They log in themselves.** You never hold their credentials. This is both the safe design and the one that survives a security review.
- Give them the caps in §3.2 as defaults and tell them plainly why raising them is their risk, not yours.
- Have them run the warm-up in §3.3 even on an established account.
- One account per machine per day. Two accounts from one IP on the same day is a correlation you don't need.

### 3.6 What this does not do, and why

There is no fingerprint spoofing, canvas noise, proxy rotation, or "stealth" patching here. Those are an arms race on the platform's timetable, they break silently when the detection updates, and a spoofed fingerprint that mismatches your real one is *more* anomalous than an honest one. Volume and rhythm are what actually get accounts restricted, and that is what the governor controls.

One thing to say out loud rather than bury: automated collection is against LinkedIn's User Agreement regardless of how carefully it is paced, and the account bears that risk. The controls here reduce the chance of a restriction; they do not make this sanctioned. Run it on an account you can afford to lose, and keep the lead data in the sheet so the pipeline survives if the account does not.

---

## 4. Daily operating procedure

**Morning (10:00 IST, ~35 min)**
1. `node src/index.js --profile=default`
2. Watch the first minute. If a checkpoint appears, stop and follow §3.4.
3. Let it finish. Do not touch the browser window while it runs.

**Midday (13:00 IST, ~20 min) — review**
4. Open the Sheet → **Leads** tab. Sort by Score.
5. Spot-check five rows against the **Scoring Rationale** column. If a score looks wrong, the rationale tells you which signal caused it — fix the regex in `config.scoring`, not the row.
6. Open **Message Drafts**. Read every draft. Check the company name and the role-volume number against the Careers URL in the same row.
7. Delete any draft you would not send as written. A withheld draft is a feature — it means a variable could not be verified.

**Afternoon (15:00 IST, ~30 min) — send by hand**
8. Send **at most 15–20** messages, spread across the afternoon, from the LinkedIn UI.
9. Mark `Sent By Human? = y` and the date in the Drafts tab.
10. Second run only if the morning run hit its cap and the cooldown has passed.

**Friday (30 min) — review the numbers**
11. Reply rate by band. If Band A is not outperforming Band B, the rubric is wrong, not the message.
12. Reply rate by segment. If staffing agencies outperform enterprises (they should), reweight toward them.
13. Update the funnel table in §1 with your real rates.

---

## 5. Message policy

The template is fixed in `config.json`. Three rules govern changes:

1. **Never invent a variable.** If openings could not be counted, the draft is withheld. "I noticed you post 10–15 roles a month" to someone posting two is the fastest way to lose a CHRO permanently.
2. **Vary the wording, never the claim.** Drafts rotate through three openers and closers so ten messages aren't textually identical — duplicate-text detection is real, and identical messages read like spam to humans too. The offer, the 24-hour claim, and the link never change.
3. **Every claim must be checkable.** "24 hours instead of 4 days", the free tier, the ranked-and-explained output — all are in the buyer's guide and all are verifiable by the prospect. Nothing in a draft should outrun that document.

---

## 6. Success metrics

| Metric | Target | Where |
|---|---|---|
| Leads scored per week | 200 | Run Log tab |
| Band A+B share of scored | ≥45% | Leads tab |
| Drafts withheld | <20% | Drafts tab — higher means careers validation is failing |
| Reply rate | ≥12% | Manual, Drafts tab |
| Trial starts | ≥40% of replies | MinMaxHR signups |
| Paid conversion | ≥25% of trials | MinMaxHR billing |
| **Account restrictions** | **0** | The one that ends the campaign |

---

## 7. Roadmap — other sources, scheduled

LinkedIn is the first source, not the only one. The architecture already separates *sourcing* from *scoring, validating, drafting and writing*, so a new source only has to produce `{name, title, company, location, url}`:

- **Naukri / Indeed / Foundit** — search by recruiter, not candidate. Identifies high-volume hirers directly, with no LinkedIn risk.
- **Careers-page crawler** — `src/careers.js` already counts openings; point it at a company list and it finds high-volume hirers without any social platform.
- **Funding announcements** — a Series A/B is a hiring spike 60 days out. Best timing signal available.
- **Job boards by ATS** — companies on Greenhouse / Lever / Keka are already tooling-aware and buy faster.

Scheduling: once the daily run is stable, wrap it in a cron entry inside the active-hours window, at a **randomised minute** — a job that fires at exactly 10:00:00 every day is its own pattern. The governor enforces the caps whether a human or cron started the run.
