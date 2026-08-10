/**
 * signals.js — timing evidence.
 *
 * The Timing axis is only as good as the evidence behind it, so this module
 * exists to keep that evidence honest. Every signal records where it came from
 * and when it was observed. Nothing is inferred from vibes.
 *
 * Currently populated:
 *   hiring_volume    — counted live openings on the company's own careers page
 *   ats              — ATS embed detected on that page
 *   post_engagement  — the person interacted with our content (Lane B)
 *   recent_connection— connected in the last 90 days, so the intro is still warm
 *
 * Declared in the schema but NOT populated, deliberately:
 *   funding, new_leader — both are strong timing signals and both need a data
 *   source we do not have yet (a funding feed, or repeated profile snapshots to
 *   detect a job change). Writing a guesser for them would put invented
 *   evidence into a scoring axis, which is exactly what this design is built to
 *   avoid. They are wired through end-to-end, so the day a source is added they
 *   start counting with no other change.
 */

const DAY = 86400000;

/** All signals recorded against a company, plus those of its people. */
function signalsForCompany(db, companyId) {
  const own = db.prepare(
    'SELECT * FROM signals WHERE entity_type = ? AND entity_id = ?'
  ).all('company', companyId);

  const viaPeople = db.prepare(`
    SELECT s.* FROM signals s
    JOIN people p ON p.id = s.entity_id
    WHERE s.entity_type = 'person' AND p.company_id = ?
  `).all(companyId);

  return [...own, ...viaPeople];
}

/** Per-person flags the Access axis cares about, keyed by person id. */
function personSignalMap(db, companyId) {
  const rows = db.prepare(`
    SELECT s.entity_id AS person_id, s.kind FROM signals s
    JOIN people p ON p.id = s.entity_id
    WHERE s.entity_type = 'person' AND p.company_id = ?
  `).all(companyId);

  const map = {};
  for (const r of rows) {
    map[r.person_id] = map[r.person_id] || {};
    if (r.kind === 'post_engagement') map[r.person_id].engaged = true;
  }
  return map;
}

/**
 * Derives the recency signal from connection dates already in the DB.
 * Someone you connected with last month remembers you; someone from 2019
 * probably does not, and the opener has to acknowledge that difference.
 */
function deriveConnectionRecency(db, config) {
  const people = db.prepare(
    "SELECT id, company_id, connected_on FROM people WHERE degree = 1 AND connected_on IS NOT NULL"
  ).all();

  let added = 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO signals (entity_type, entity_id, kind, value, detail, source, observed_at)
    VALUES ('person', ?, 'recent_connection', ?, ?, 'connections-export', ?)
  `);

  for (const p of people) {
    const when = Date.parse(p.connected_on);
    if (!when || Number.isNaN(when)) continue;
    const days = (Date.now() - when) / DAY;
    if (days <= 90) {
      insert.run(p.id, Math.round(days), `connected ${Math.round(days)} days ago`, new Date().toISOString());
      added++;
    }
  }
  return added;
}

/** How stale is our hiring evidence for this company? */
function evidenceAgeDays(company) {
  if (!company.openings_checked_at) return Infinity;
  return Math.round((Date.now() - Date.parse(company.openings_checked_at)) / DAY);
}

module.exports = { signalsForCompany, personSignalMap, deriveConnectionRecency, evidenceAgeDays };
