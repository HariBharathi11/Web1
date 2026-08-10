# Standard Operating Procedure — MinMaxHR Revenue Engine

**Objective:** 20 paying MinMaxHR clients.
**Absolute rule:** this system drafts messages. It never sends one. Sending is a human action.

---

## 1. The one thing to understand first

Your ~2,000 first-degree connections are the asset. Everything else in this document is secondary.

LinkedIn will hand you that entire network as a CSV, officially, in about five minutes:

> **Settings & Privacy → Data Privacy → Get a copy of your data → Connections → Request archive**

Name, company, position, connected-on date, for every connection you have. **Zero bot detection surface. Zero rate limit. Zero terms-of-service exposure.** No automation is involved, because none is needed.

Compare the two sourcing routes honestly:

| | Warm export | Cold search |
|---|---|---|
| Leads available | ~2,000, immediately | ~10/day, at risk |
| Reply rate | ~30% | ~12% |
| Account risk | none | real |
| Cost to acquire | one download | the whole governor apparatus |

This is why the cold scraper — the thing that was the entire product in v1 — is now the third and smallest lane. Run the export on day one, before anything else.

---

## 2. The maths — what 20 clients actually requires

| Stage | Warm (Lane A) | Cold (Lane C) |
|---|---|---|
| Sourced | 2,000 connections | — |
| ICP-relevant after classification | ~500 people / ~300 companies | — |
| Band A+B after the Venn | ~200 | ~150 over 10 weeks |
| Reply rate | 30% | 12% |
| Replies | 60 | 18 |
| Trial starts (40% of replies) | 24 | 7 |
| **Paid (25% of trials)** | **~15** | **~5** |

**≈20 paying clients in 10–12 weeks**, with the warm network carrying three quarters of it.

Those percentages are planning assumptions, not measured facts — replace each with your own number after the first 200 sends, and update this table. The shape is what matters: **the binding constraint is your own sending capacity (15–20 thoughtful messages a day), not how many leads we can safely scrape.** That is the right constraint to be held by, because it carries no account risk at all.

Do not try to compress this by raising the daily caps. That trades a 12-week campaign for a restricted account and a 0-week campaign.

---

## 3. The Venn — where outreach capacity goes

Three axes, scored independently, combined as a **weighted geometric mean**:

```
priority = fit^0.40 × access^0.35 × timing^0.25
```

| Axis | Question | Driven by |
|---|---|---|
| **Fit** | Is this company worth selling to? | Segment, validated hiring volume, ICP contacts mapped, × region multiplier |
| **Access** | Can we reach someone who can say yes? | Connection degree, seniority, engagement, number of routes in |
| **Timing** | Is the pain live *now*? | Live openings, ATS, funding, new HR leader, recent posts |

**Geometric, not additive, and that is the entire point.** A zero on any axis zeroes the account:

- A perfect-fit enterprise you have no route into → **dead**
- A warm first-degree CHRO at a company that is not hiring → **dead**
- A hiring company you neither fit nor can reach → **dead**

An additive score would let two strong axes carry a dead one, and you would spend your 20 daily messages on leads that only look good on one dimension. Only the intersection survives.

**Bands:** A ≥ 75 (draft now) · B 60–74 (draft second) · C < 60 (never contacted).

### Region multipliers

| Region | ×  | Note |
|---|---|---|
| India | 1.0 | Baseline. High volume, fast cycles, ₹9,999 Growth plan. |
| Gulf | 1.6 | Large staffing sector, budget, English-first. |
| Singapore | 1.5 | Regional HQs, enterprise budgets. |
| Europe | 1.3 | Higher value; GDPR review adds a step. |
| USA | 1.8 | Highest value — **but see below.** |

**US and EU enterprises are automatically downgraded ×0.45** and carry a visible `SOC 2 not yet certified` blocker. Your own buyer's guide says a hard SOC 2 gate is a genuine non-fit today. Pitching into that gate wastes the send and, worse, the credibility of a document whose whole strength is that it names its own poor fit. **In the US and EU, target staffing agencies, not enterprises.**

---

## 4. ICP definition

### Highest priority — staffing / RPO / recruitment agencies (any region)
Scored +40 on Fit, ahead of headcount-matched enterprises. For them shortlist speed is **revenue**, not overhead — they win or lose mandates on it. No internal-tooling committee, so they decide in days rather than quarters.
**Lead with:** submittal speed and defensibility when a client challenges a shortlist.

### Tier 1 contacts (score 90–100 on the old rubric, `tier1` here)
CHRO, CPO, VP HR, Head of HR/People/Talent — **and, at agencies, the Founder or MD**, because at a 20-person staffing firm the founder *is* the buyer and classifying them as "not HR" loses the best segment entirely.
**Lead with:** defensibility and the audit trail. This buyer has been asked "why was this candidate dropped?" and had no answer.

### Tier 2 contacts
HR Manager, TA Lead, Recruitment Manager, HRBP, People Ops Lead. They personally read the pile.
**Lead with:** recruiter hours — 40+ a month per recruiter reading documents.

### Explicitly not a fit — do not draft, whatever the score
- Teams who want an ATS (MinMaxHR is not one; pretending otherwise loses the second call)
- Anyone wanting humans removed from hiring (deliberately not built)
- Anyone wanting a sourcing agency (this ranks applicants you already have)
- Procurement with a hard SOC 2 gate today

---

## 5. Detection avoidance

Understand what is actually being detected. It is not "a browser" — it is a **rhythm**. Platforms score sessions on the *distribution* of behaviour over time: gap variance, scroll direction changes, idle periods, session length, day-over-day consistency, and volume relative to your own history. Nothing here defeats detection by disguise. It works by not producing an inhuman pattern in the first place.

**The strongest control is architectural: Lanes A and B do not touch LinkedIn search at all.** The warm export is a file download. Enrichment runs against public company websites from a separate cookie-less browser. Only Lane C — 10 profiles a day — touches LinkedIn, and it is optional.

### 5.1 Built in, automatic (Lane C only)

| Behaviour | Why |
|---|---|
| **Real headed Chromium, persistent profile** | Headless is trivially fingerprinted. A real profile with real cookies has nothing to disguise. |
| **Manual login, once, by hand** | Scripted logins are the single most-flagged event. The password is never typed or stored by the script. |
| **Log-normal delays, not uniform** | A flat `random(2000,3000)` is *itself* a signature — real gaps cluster with a long tail. Measured: p50 2.4s, p90 3.2s, 7% chance of a much longer pause. |
| **Session persona** | Every run picks a mood (skimming / steady / thorough / distracted) scaling every timing multiplier. Two runs never share a pace fingerprint. |
| **Bézier mouse paths, off-centre clicks** | Measured 21–25 intermediate move events per click. A bot teleport produces 1. |
| **Non-monotonic scrolling** | 25% of bursts scroll **upward** (re-reading), with overshoot-and-correct and varying wheel deltas. A strictly increasing scrollY with even deltas is the cleanest tell there is. |
| **Search via the real search box** | Typed character-by-character with occasional typo + backspace. Deep-linking to `/search/results/people/?keywords=` with no referrer is a navigation pattern users do not produce. |
| **Randomised order, 12% abandon rate** | Results are visited in *near*-rank order with local swaps and skips. Perfect follow-through is not human. |
| **Organic detours** | Between batches the session visits feed / network / notifications. A session that is 100% extraction and 0% consumption is anomalous on its face. |
| **Long breaks** | 45s–150s step-aways every 5–8 profiles. |
| **Cookie-less context for company sites** | Careers-page traffic never touches the LinkedIn session. |

### 5.2 The governor

`src/session.js` refuses to start a Lane C run that would look mechanical:

- **09:00–20:00 IST only** — a sourcing session at 03:00 is the loudest signal you can send
- **Weekdays only**
- **Max 2 runs/day**, **3-hour cooldown** between them
- **Hard cap 40 profile views/day**, 10 per cold run — enforced across runs on disk, so `--force` still cannot exceed the daily cap

**Lanes A and B are unaffected by the governor.** When it blocks Lane C, keep working — the revenue lane is still open.

### 5.3 Commercial Use Limit — a quota, not a warning

Free accounts have a monthly search allowance. Hit it (typically week three) and search stops until the 1st. **This is not a restriction and the account is in no danger.** The engine detects it, stops the cold lane, and says so. The correct response is to keep working the warm lane, which does not consume the quota because it does not search.

### 5.4 The touch sequence — why it is also the safest pattern

For every drafted lead the engine schedules three human-executed steps:

```
Day 0   view their profile      (they get the notification — you exist again)
Day 1   react to a recent post  (now a name they have seen twice)
Day 2   send the message        (lands as a follow-up, not a cold open)
```

This lifts reply rates, and it lowers the detection profile at the same time — three light touches spread over three days is indistinguishable from a person catching up with their network, because that is exactly what it is. **The behaviour that sells better is also the behaviour that looks more human.** That alignment is why it is built in rather than left to discipline.

### 5.5 Warm-up — mandatory for a new or dormant account

Yours is established (~2,000 connections), so you can start at full Lane C volume. A client's new account cannot:

| Days | Cold profiles/run | Runs/day |
|---|---|---|
| 1–3 | 3 | 1 |
| 4–7 | 5 | 1 |
| 8–14 | 8 | 2 |
| 15+ | 10 | 2 |

During warm-up, use the account normally by hand too. An account with organic activity absorbs far more automation than one that only ever runs the script.

### 5.6 Stop conditions — non-negotiable

The engine aborts on: checkpoint / auth wall, "We've restricted", "unusual activity", "Please verify", "try again later".

1. **Stop. Do not re-run today.** Pushing through a soft warning is how it becomes a hard restriction.
2. Open LinkedIn manually in that profile. Browse normally for a day.
3. Resume at **half** the previous limits, ramping back over a week.
4. Complete any checkpoint by hand before anything else.

**Lanes A and B stay open throughout.** A restricted account does not stop the pipeline — that is the point of keeping the data in SQLite and the sheet.

### 5.7 Client deployments

- One `--profile=<name>` per account — separate cookie jar, viewport, and usage counter. No bleed.
- **They log in themselves.** You never hold their credentials. Safe design and survives a security review.
- Give them the §5.5 warm-up even on an established account.
- One account per machine per day. Two accounts from one IP is a correlation you do not need.

### 5.8 What this deliberately does not do

No fingerprint spoofing, canvas noise, proxy rotation, or "stealth" patching. Those are an arms race on the platform's timetable, they break silently when detection updates, and a spoofed fingerprint that mismatches your real one is *more* anomalous than an honest one.

Stated plainly rather than buried: automated collection breaches LinkedIn's User Agreement however carefully it is paced, and the account carries that risk. These controls reduce the chance of a restriction; they do not make it sanctioned. That is precisely why the architecture puts three quarters of the revenue in a lane that involves no automation at all.

---

## 6. Daily operating procedure

**One-time setup**
1. Export connections (§1). Save to `leadgen/input/Connections.csv`.
2. Set up Sheets auth (README § Google Sheets API auth).
3. `npm run daily` — imports, enriches, scores, drafts, syncs.

**Every morning (~15 min)**
4. `npm run daily` — re-imports (idempotent), enriches companies not checked in 21 days, re-scores, drafts, syncs.
5. Open the Sheet → **Daily Actions**. This is your worklist, ordered by account priority.

**Every afternoon (~45 min) — the work that earns the money**
6. Do the **view** and **engage** steps. They take seconds each.
7. Read every **message** draft before sending. Check the company name and the volume claim against the Careers URL in the Companies tab.
8. Send **at most 15–20**, spread across the afternoon, from the LinkedIn UI, by hand.
9. Mark `Done? = y` in Daily Actions and fill `Sent On` in Message Drafts.

**Optional, twice a day (~20 min)**
10. `npm run cold` — tops up segments the warm network does not cover. Skip it whenever you like; it is the smallest contributor.

**Every Friday (~30 min)**
11. Reply rate by band. If Band A is not outperforming Band B, the rubric is wrong, not the message.
12. Reply rate by segment. If staffing agencies outperform enterprises (they should), reweight toward them in `config.json`.
13. Update §2 with your real numbers.

---

## 7. Message policy

1. **Never invent a variable.** If openings could not be counted, the draft is withheld. "I noticed you post 10–15 roles a month" to someone posting two is unrecoverable — they are the one person guaranteed to know the real number.
2. **The monthly claim is deliberately conservative.** A careers page accumulates ~2 months of postings, so the engine claims ~45% of the live count. Tested to always fall below the observed number.
3. **Vary the wording, never the claim.** 20 angles across 4 segments × 5 situations. The offer, the 24-hour claim and the link are constant, and all trace to the buyer's guide.
4. **One contact per company per week.** Messaging three people at one firm reads as a blast, not outreach. The engine enforces this.
5. **Every claim must be checkable.** Nothing in a draft outruns the buyer's guide, because the prospect can read it.

---

## 8. Success metrics

| Metric | Target | Where |
|---|---|---|
| Accounts scored | 300+ after warm import | Accounts tab |
| Band A+B share | ≥40% | Accounts tab |
| Drafts withheld | <20% | Drafts tab — higher means enrichment is failing |
| Actions completed daily | ≥90% of worklist | Daily Actions tab |
| Reply rate (warm) | ≥25% | Manual |
| Trial starts | ≥40% of replies | MinMaxHR signups |
| Paid conversion | ≥25% of trials | MinMaxHR billing |
| **Account restrictions** | **0** | The one that ends the campaign |

---

## 9. Roadmap

The architecture separates *sourcing* from *scoring, enrichment, drafting and rendering*. A new source only has to produce `{name, title, company, location, url}` and everything downstream works unchanged.

- **Lane B expansion** — post engagers and profile viewers. Low risk, natural openers, already scaffolded.
- **Funding and new-leader signals** — both are wired through the Timing axis end-to-end but deliberately **not populated**, because we have no source for them yet and inventing evidence for a scoring axis is exactly what this design avoids. Add a funding feed and they start counting with no other change.
- **Instagram / Facebook / WhatsApp** — handles are already being harvested from company website footers into the Companies tab, so the channel data is accumulating now without touching those platforms. Widen the GTM only once LinkedIn is proven.
- **Naukri / Indeed / Foundit** — search by recruiter rather than candidate. Identifies high-volume hirers with no LinkedIn risk.
- **Scheduling** — once the daily run is stable, cron it inside the active-hours window at a **randomised minute**. A job firing at exactly 10:00:00 daily is its own pattern. The governor enforces caps whether a human or cron started the run.
