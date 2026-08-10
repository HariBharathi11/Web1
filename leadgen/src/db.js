/**
 * db.js — the pipeline store.
 *
 * Phase 1 kept leads in one JSON file per run. That could not express "three
 * ICP people at one company", could not enrich incrementally, and recomputed
 * everything on every run — which is exactly the waste we are trying to remove.
 *
 * This is company-first: companies are the unit of sale, people are how you
 * reach them. Everything is keyed and timestamped so a run only does work that
 * has not already been done. Google Sheets becomes a rendered *view* of this
 * database, never the store of record.
 *
 * Uses Node's built-in `node:sqlite` (Node 22+) — no native module to compile,
 * nothing for a client to fail to install.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const STATE_DIR = path.resolve(__dirname, '..', '.state');
const DB_PATH = path.join(STATE_DIR, 'pipeline.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS companies (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  key                TEXT UNIQUE NOT NULL,   -- normalised name, the dedupe anchor
  name               TEXT NOT NULL,
  domain             TEXT,
  linkedin_url       TEXT,
  region             TEXT,
  country            TEXT,
  size_band          TEXT,
  segment            TEXT,                   -- staffing | enterprise | midmarket | startup
  careers_url        TEXT,
  ats                TEXT,
  live_openings      INTEGER DEFAULT 0,
  openings_checked_at TEXT,
  socials            TEXT,                   -- json
  blockers           TEXT,                   -- json
  first_seen_at      TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  linkedin_url       TEXT UNIQUE,
  company_id         INTEGER REFERENCES companies(id),
  name               TEXT NOT NULL,
  title              TEXT,
  seniority_tier     TEXT,                   -- tier1 | tier2 | tier3 | other
  location           TEXT,
  degree             INTEGER DEFAULT 3,      -- 1 = first-degree connection
  connected_on       TEXT,
  email              TEXT,
  source_lane        TEXT,                   -- warm | engagement | cold
  profile_checked_at TEXT,
  first_seen_at      TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type  TEXT NOT NULL,                -- company | person
  entity_id    INTEGER NOT NULL,
  kind         TEXT NOT NULL,                -- hiring_volume | ats | funding | post_engagement | new_leader
  value        REAL,
  detail       TEXT,
  source       TEXT,
  observed_at  TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, kind, observed_at)
);

CREATE TABLE IF NOT EXISTS accounts (
  company_id    INTEGER PRIMARY KEY REFERENCES companies(id),
  fit           REAL, access REAL, timing REAL, priority REAL,
  band          TEXT,
  next_action   TEXT,
  reasoning     TEXT,                        -- json, per-axis written reasons
  scored_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id       INTEGER NOT NULL REFERENCES people(id),
  angle           TEXT,
  body            TEXT,
  status          TEXT,                      -- DRAFT | WITHHELD
  note            TEXT,
  created_at      TEXT NOT NULL,
  sent_by_human_at TEXT,                     -- only ever written by a human
  UNIQUE(person_id)
);

CREATE TABLE IF NOT EXISTS touches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES people(id),
  step        TEXT NOT NULL,                 -- view | engage | message
  due_on      TEXT NOT NULL,
  done_at     TEXT,
  UNIQUE(person_id, step)
);

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT, finished_at TEXT,
  lane          TEXT, persona TEXT,
  profiles_seen INTEGER, companies_touched INTEGER,
  outcome       TEXT
);

CREATE INDEX IF NOT EXISTS idx_people_company ON people(company_id);
CREATE INDEX IF NOT EXISTS idx_signals_entity ON signals(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_accounts_priority ON accounts(priority DESC);
`;

// ---------------------------------------------------------------------------
// Company name normalisation — the dedupe anchor
// ---------------------------------------------------------------------------

/**
 * "Infosys Ltd.", "INFOSYS", "Infosys Limited" and "Infosys Pvt Ltd" are one
 * account, and the whole company-first model collapses if they are four. Strips
 * legal suffixes, punctuation and case to produce a stable key.
 */
function companyKey(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(pvt|private|ltd|limited|inc|incorporated|llp|llc|plc|gmbh|co|corp|corporation|company|group|holdings|technologies|technology|solutions|services|consulting|india)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

// ---------------------------------------------------------------------------

function open() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  return db;
}

const now = () => new Date().toISOString();

/** Insert or merge a company. Existing non-empty fields are never overwritten with blanks. */
function upsertCompany(db, c) {
  const key = companyKey(c.name);
  if (!key) return null;

  // Segment is derivable from the name alone, so never leave it blank — a
  // missing segment silently costs the company its Fit points.
  if (!c.segment) c.segment = require('./venn').segmentOf({ name: c.name });

  const existing = db.prepare('SELECT * FROM companies WHERE key = ?').get(key);
  const t = now();

  if (!existing) {
    const info = db.prepare(`
      INSERT INTO companies (key, name, domain, linkedin_url, region, country, size_band,
        segment, careers_url, ats, live_openings, openings_checked_at, socials, blockers,
        first_seen_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      key, c.name, c.domain || null, c.linkedin_url || null, c.region || null,
      c.country || null, c.size_band || null, c.segment || null, c.careers_url || null,
      c.ats || null, c.live_openings ?? 0, c.openings_checked_at || null,
      JSON.stringify(c.socials || {}), JSON.stringify(c.blockers || []), t, t
    );
    return Number(info.lastInsertRowid);
  }

  const merged = {
    domain: c.domain || existing.domain,
    linkedin_url: c.linkedin_url || existing.linkedin_url,
    region: c.region || existing.region,
    country: c.country || existing.country,
    size_band: c.size_band || existing.size_band,
    segment: c.segment || existing.segment,
    careers_url: c.careers_url || existing.careers_url,
    ats: c.ats || existing.ats,
    live_openings: c.live_openings ?? existing.live_openings,
    openings_checked_at: c.openings_checked_at || existing.openings_checked_at,
    socials: JSON.stringify({ ...JSON.parse(existing.socials || '{}'), ...(c.socials || {}) }),
    blockers: JSON.stringify(c.blockers || JSON.parse(existing.blockers || '[]')),
  };

  db.prepare(`
    UPDATE companies SET domain=?, linkedin_url=?, region=?, country=?, size_band=?,
      segment=?, careers_url=?, ats=?, live_openings=?, openings_checked_at=?,
      socials=?, blockers=?, updated_at=? WHERE id=?
  `).run(
    merged.domain, merged.linkedin_url, merged.region, merged.country, merged.size_band,
    merged.segment, merged.careers_url, merged.ats, merged.live_openings,
    merged.openings_checked_at, merged.socials, merged.blockers, t, existing.id
  );

  return existing.id;
}

/** Insert or merge a person. Degree only ever improves (3rd → 1st), never regresses. */
function upsertPerson(db, p) {
  const t = now();
  const url = (p.linkedin_url || '').split('?')[0].replace(/\/$/, '') || null;
  const existing = url ? db.prepare('SELECT * FROM people WHERE linkedin_url = ?').get(url) : null;

  if (!existing) {
    const info = db.prepare(`
      INSERT INTO people (linkedin_url, company_id, name, title, seniority_tier, location,
        degree, connected_on, email, source_lane, profile_checked_at, first_seen_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      url, p.company_id || null, p.name, p.title || null, p.seniority_tier || null,
      p.location || null, p.degree ?? 3, p.connected_on || null, p.email || null,
      p.source_lane || null, p.profile_checked_at || null, t, t
    );
    return Number(info.lastInsertRowid);
  }

  db.prepare(`
    UPDATE people SET company_id=?, title=?, seniority_tier=?, location=?,
      degree=?, connected_on=?, email=?, source_lane=?, profile_checked_at=?, updated_at=?
    WHERE id=?
  `).run(
    p.company_id || existing.company_id,
    p.title || existing.title,
    p.seniority_tier || existing.seniority_tier,
    p.location || existing.location,
    Math.min(p.degree ?? 3, existing.degree ?? 3), // closer connection wins
    p.connected_on || existing.connected_on,
    p.email || existing.email,
    p.source_lane || existing.source_lane,
    p.profile_checked_at || existing.profile_checked_at,
    t, existing.id
  );
  return existing.id;
}

function addSignal(db, { entity_type, entity_id, kind, value, detail, source }) {
  db.prepare(`
    INSERT OR IGNORE INTO signals (entity_type, entity_id, kind, value, detail, source, observed_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(entity_type, entity_id, kind, value ?? null, detail || null, source || null, now());
}

function saveAccount(db, companyId, s) {
  db.prepare(`
    INSERT INTO accounts (company_id, fit, access, timing, priority, band, next_action, reasoning, scored_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(company_id) DO UPDATE SET
      fit=excluded.fit, access=excluded.access, timing=excluded.timing,
      priority=excluded.priority, band=excluded.band, next_action=excluded.next_action,
      reasoning=excluded.reasoning, scored_at=excluded.scored_at
  `).run(companyId, s.fit, s.access, s.timing, s.priority, s.band, s.next_action,
         JSON.stringify(s.reasoning || {}), now());
}

function saveDraft(db, personId, d) {
  db.prepare(`
    INSERT INTO drafts (person_id, angle, body, status, note, created_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET
      angle=excluded.angle, body=excluded.body, status=excluded.status, note=excluded.note
  `).run(personId, d.angle || null, d.body || '', d.status, d.note || null, now());
}

/** Companies that still need careers-page enrichment, priciest-first by people count. */
function companiesNeedingEnrichment(db, { maxAgeDays = 21, limit = 20 } = {}) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  return db.prepare(`
    SELECT c.*, COUNT(p.id) AS people_count
    FROM companies c LEFT JOIN people p ON p.company_id = c.id
    WHERE c.openings_checked_at IS NULL OR c.openings_checked_at < ?
    GROUP BY c.id
    ORDER BY people_count DESC, c.first_seen_at ASC
    LIMIT ?
  `).all(cutoff, limit);
}

function peopleForCompany(db, companyId) {
  return db.prepare('SELECT * FROM people WHERE company_id = ? ORDER BY degree ASC').all(companyId);
}

function allCompanies(db) {
  return db.prepare('SELECT * FROM companies').all();
}

function topAccounts(db, limit = 50) {
  return db.prepare(`
    SELECT a.*, c.name, c.domain, c.region, c.segment, c.live_openings, c.careers_url
    FROM accounts a JOIN companies c ON c.id = a.company_id
    ORDER BY a.priority DESC LIMIT ?
  `).all(limit);
}

module.exports = {
  open, companyKey, upsertCompany, upsertPerson, addSignal, saveAccount, saveDraft,
  companiesNeedingEnrichment, peopleForCompany, allCompanies, topAccounts,
  DB_PATH, STATE_DIR, now,
};
