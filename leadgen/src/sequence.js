/**
 * sequence.js — the touch sequence.
 *
 * Messaging a first-degree connection you have never actually spoken to still
 * converts badly. What works is what a good salesperson does by hand:
 *
 *   Day 0  view their profile        (they get the notification — you exist again)
 *   Day 1  react to a recent post    (you are now a name they saw twice)
 *   Day 2  send the message          (which now lands as a follow-up, not a cold open)
 *
 * There is a second benefit, and it is not incidental. This sequence is
 * indistinguishable from normal LinkedIn use, because it *is* normal LinkedIn
 * use — a person catching up with their network. Three light touches spread
 * over three days produce a far calmer account signature than twenty profile
 * views in one session, so the behaviour that lifts reply rates also lowers the
 * detection profile. That alignment is the reason the sequence is built in
 * rather than left to discipline.
 *
 * Every step is EXECUTED BY A HUMAN. This module only schedules them and
 * renders the daily worklist. Nothing here clicks anything.
 */

const DAY = 86400000;

const STEPS = [
  { step: 'view',    offsetDays: 0, instruction: 'Open their profile. Just look — they get the notification.' },
  { step: 'engage',  offsetDays: 1, instruction: 'React to or comment on one of their recent posts. Skip if they have not posted.' },
  { step: 'message', offsetDays: 2, instruction: 'Send the drafted message. Read it first and edit anything that reads wrong.' },
];

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/** Next working day at or after a date — sequences should not land on weekends. */
function nextWorkingDay(ms) {
  const d = new Date(ms);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

/**
 * Schedules a sequence for one person. Idempotent — re-running a scoring pass
 * will not duplicate or reset touches that are already underway.
 */
function scheduleSequence(db, personId, startAt = Date.now()) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO touches (person_id, step, due_on) VALUES (?,?,?)
  `);
  for (const s of STEPS) {
    insert.run(personId, s.step, isoDate(nextWorkingDay(startAt + s.offsetDays * DAY)));
  }
}

/**
 * The worklist for today: every touch due on or before today that is not done,
 * ordered so the highest-priority accounts get worked first.
 *
 * Capped at the daily send ceiling for message steps — the constraint that
 * actually binds this whole operation is how many messages a human can
 * thoughtfully send in a day, and it is better to hit that limit here, in the
 * plan, than three hours into an afternoon.
 */
function dueToday(db, config, today = isoDate(Date.now())) {
  const rows = db.prepare(`
    SELECT t.id, t.person_id, t.step, t.due_on,
           p.name, p.title, p.linkedin_url, p.degree,
           c.name AS company, c.id AS company_id,
           a.priority, a.band,
           d.body AS draft_body, d.status AS draft_status
    FROM touches t
    JOIN people p    ON p.id = t.person_id
    LEFT JOIN companies c ON c.id = p.company_id
    LEFT JOIN accounts a  ON a.company_id = p.company_id
    LEFT JOIN drafts d    ON d.person_id = p.id
    WHERE t.done_at IS NULL AND t.due_on <= ?
    ORDER BY a.priority DESC, t.due_on ASC
  `).all(today);

  const ceiling = config.outreach.dailySendCeiling;
  let messages = 0;
  const out = [];

  for (const r of rows) {
    if (r.step === 'message') {
      // Never queue a message whose draft was withheld — that is the guard
      // doing its job, and it must not be quietly worked around here.
      if (r.draft_status !== 'DRAFT') continue;
      if (messages >= ceiling) continue;
      messages++;
    }
    out.push({
      ...r,
      instruction: STEPS.find((s) => s.step === r.step)?.instruction || '',
    });
  }

  return { actions: out, messagesQueued: messages, ceiling };
}

/** Marks a touch done. Called only when a human confirms they did it. */
function markDone(db, touchId) {
  db.prepare('UPDATE touches SET done_at = ? WHERE id = ?').run(new Date().toISOString(), touchId);
}

module.exports = { scheduleSequence, dueToday, markDone, STEPS, isoDate, nextWorkingDay };
