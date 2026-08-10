/**
 * lanes/warm.js — the warm network lane.
 *
 * This is the highest-leverage file in the project, and it contains no
 * automation at all.
 *
 * LinkedIn will hand you your entire first-degree network as a CSV, officially:
 *   Settings & Privacy → Data Privacy → Get a copy of your data →
 *   "Connections" → Request archive. It arrives by email, usually in minutes.
 *
 * ~2,000 rows of name, company, position and connected-on date, with zero bot
 * detection surface, zero rate limit, and zero terms-of-service exposure —
 * because no bot is involved. Every one of those people is a first-degree
 * connection, which means a message that lands in their inbox and gets read,
 * not a connection request that sits pending.
 *
 * On every axis that matters — reply rate, risk, and speed — this beats cold
 * search. It is why the cold scraper is now the third and smallest lane.
 */

const fs = require('fs');
const path = require('path');
const { upsertCompany, upsertPerson } = require('../db');
const { classifySeniority } = require('../score');
const { segmentOf } = require('../venn');

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * RFC4180-ish parser. Written by hand rather than pulled in as a dependency
 * because the input is one known shape, and company names are full of commas
 * and quotes ("Smith, Jones & Co") that a naive split destroys.
 */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/**
 * LinkedIn prefixes the export with a few "Notes:" lines before the real
 * header. Find the row that actually looks like the header rather than
 * assuming a fixed offset — the preamble length has changed before.
 */
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const lower = rows[i].map((c) => c.trim().toLowerCase());
    if (lower.includes('first name') && (lower.includes('company') || lower.includes('url'))) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Reads Connections.csv and loads it into the pipeline as companies + people.
 * Everyone here is degree 1 by definition — that is what a connection is, and
 * it is what makes the Access axis score them so highly.
 *
 * Returns a summary; the caller decides what to do with it.
 */
function importConnections(db, config, csvPath) {
  const file = path.isAbsolute(csvPath) ? csvPath : path.resolve(__dirname, '..', '..', csvPath);

  if (!fs.existsSync(file)) {
    return {
      ok: false,
      reason: `No connections export at ${file}`,
      howTo: 'LinkedIn → Settings & Privacy → Data Privacy → Get a copy of your data → Connections → Request archive. Save the CSV to that path.',
    };
  }

  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const headerIdx = findHeader(rows);
  if (headerIdx === -1) {
    return { ok: false, reason: 'Could not find a header row — is this the Connections.csv from the LinkedIn export?' };
  }

  const header = rows[headerIdx].map((c) => c.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iFirst = col('first name'), iLast = col('last name'), iUrl = col('url');
  const iCompany = col('company'), iPosition = col('position');
  const iConnected = col('connected on'), iEmail = col('email address');

  const stats = {
    ok: true, rows: 0, people: 0, companies: 0,
    icp: 0, tier1: 0, tier2: 0, skippedNoCompany: 0, bySegment: {},
  };
  const companyIds = new Set();

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    stats.rows++;

    const name = [cells[iFirst], cells[iLast]].filter(Boolean).join(' ').trim();
    const companyName = (cells[iCompany] || '').trim();
    const title = (cells[iPosition] || '').trim();
    if (!name) continue;

    // No company means no account to sell to. Keep the person out of the
    // pipeline rather than creating a phantom company from a blank.
    if (!companyName) { stats.skippedNoCompany++; continue; }

    const tier = classifySeniority(title, config);

    // The connections export has no location column. Region is inferred later
    // from the company's website/careers page during enrichment; until then it
    // stays null so the Fit axis uses the OTHER multiplier rather than
    // inventing a geography.
    const companyId = upsertCompany(db, {
      name: companyName,
      segment: segmentOf({ name: companyName }),
    });
    if (!companyId) continue;
    companyIds.add(companyId);

    upsertPerson(db, {
      linkedin_url: (cells[iUrl] || '').trim() || null,
      company_id: companyId,
      name,
      title,
      seniority_tier: tier,
      degree: 1,                       // first-degree by definition
      connected_on: (cells[iConnected] || '').trim() || null,
      email: (cells[iEmail] || '').trim() || null,
      source_lane: 'warm',
    });

    stats.people++;
    if (tier === 'tier1') { stats.tier1++; stats.icp++; }
    if (tier === 'tier2') { stats.tier2++; stats.icp++; }

    const seg = segmentOf({ name: companyName });
    stats.bySegment[seg] = (stats.bySegment[seg] || 0) + 1;
  }

  stats.companies = companyIds.size;
  return stats;
}

module.exports = { importConnections, parseCsv, findHeader };
