---
description: Run the MinMaxHR daily lead pipeline and report what needs attention
---

Run the MinMaxHR revenue engine's daily pipeline and report back.

Steps:

1. `cd leadgen && npm run verify` — if anything is a ✖ blocker, stop and tell the user exactly what to fix. Do not continue past a blocker.
2. `npm run daily` — imports connections, enriches companies, re-scores, drafts, syncs to Sheets.
3. `npm run revenue` — pipeline against the ₹1,00,000/month target.

Then report, briefly:

- **New Band A/B accounts** since the last run, with their priority and why (fit/access/timing).
- **Drafts ready to send**, and any **withheld** ones with the reason — withheld means a variable could not be verified, which is the guard working, not a failure.
- **Today's action count** from the Daily Actions tab.
- **Gap to target** from the revenue map, and the single most useful next step to close it.

Rules:
- Never send a message. This tool drafts only; sending is the user's action in the LinkedIn UI.
- Do not run `npm run cold` unless the user explicitly asks — it is the only lane that touches LinkedIn.
- If the governor blocks the cold lane, that is expected and does not affect anything else. Say so and move on.
- If a company scored surprisingly, read its reasoning from the accounts table (`reasoning` column, JSON per axis) rather than guessing.

Arguments: $ARGUMENTS (e.g. "enrich 50" → run `npm run enrich -- --limit=50` first; "skip enrich" → run warm/score/draft/sync individually)
