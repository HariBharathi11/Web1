/**
 * render/sheets.js — the Google Sheet as a rendered VIEW of the database.
 *
 * The DB is the store of record; this projects it. That distinction matters in
 * practice: the sheet can be wiped, reformatted, or edited by a human without
 * losing pipeline state, and re-rendering restores it.
 *
 * One column is sacred and never written by this code: `Sent On` in the Drafts
 * tab. Only a human fills that in, after they have sent the message themselves.
 *
 * Six tabs:
 *   Accounts      the Venn scoreboard — where outreach capacity should go
 *   Companies     enrichment: domain, region, openings, ATS, socials
 *   People        the contact map, degree and seniority
 *   Message Drafts what to send, and to whom
 *   Daily Actions today's touch-sequence worklist
 *   Run Log       one row per run
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { dueToday } = require('../sequence');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const HEADERS = {
  accounts: ['Priority', 'Band', 'Company', 'Region', 'Segment', 'Fit', 'Access', 'Timing',
             'Live Openings', 'Contacts', 'Best Route', 'Blockers', 'Next Action',
             'Why Fit', 'Why Access', 'Why Timing', 'Scored At'],
  companies: ['Company', 'Domain', 'Region', 'Segment', 'Size', 'Live Openings', 'ATS',
              'Careers URL', 'LinkedIn', 'Instagram', 'Facebook', 'X', 'WhatsApp', 'Email',
              'Checked At'],
  people: ['Name', 'Title', 'Seniority', 'Company', 'Degree', 'Connected On', 'Lane',
           'LinkedIn URL', 'Email'],
  drafts: ['Rank', 'Name', 'Company', 'Title', 'Priority', 'Band', 'Angle', 'Status',
           'Message Draft', 'Note', 'LinkedIn URL', 'Sent By Human? (y/n)', 'Sent On'],
  actions: ['Due', 'Step', 'What To Do', 'Name', 'Title', 'Company', 'Priority', 'Band',
            'LinkedIn URL', 'Done? (y/n)'],
  runLog: ['Run At', 'Lane', 'Persona', 'Profiles Seen', 'Companies Touched',
           'Accounts Scored', 'Band A', 'Band B', 'Drafts', 'Duration (min)', 'Outcome'],
};

// ---------------------------------------------------------------------------

async function getClient() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.resolve(__dirname, '..', '..', 'credentials', 'service-account.json');

  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Google service-account key not found at ${keyPath}.\n` +
      'See README.md § "Google Sheets API auth" — about four minutes of setup.'
    );
  }
  const auth = new google.auth.GoogleAuth({ keyFilename: keyPath, scopes: SCOPES });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function ensureTab(sheets, spreadsheetId, title, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const found = meta.data.sheets.find((s) => s.properties.title === title);

  let sheetId = found?.properties.sheetId;
  if (!found) {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    sheetId = res.data.replies[0].addSheet.properties.sheetId;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${title}!A1`, valueInputOption: 'RAW',
    requestBody: { values: [headers] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount' } },
        { repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold' } },
      ],
    },
  });

  return sheetId;
}

/** Replaces a tab's data rows, leaving the header intact. */
async function writeTab(sheets, spreadsheetId, title, headers, rows) {
  await ensureTab(sheets, spreadsheetId, title, headers);
  const lastCol = String.fromCharCode(64 + Math.min(headers.length, 26));

  await sheets.spreadsheets.values.clear({
    spreadsheetId, range: `${title}!A2:${lastCol}100000`,
  });

  if (rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${title}!A2`, valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

const j = (v) => { try { return JSON.parse(v || '{}'); } catch { return {}; } };
const arr = (v) => { try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } };

function accountRows(db) {
  const rows = db.prepare(`
    SELECT a.*, c.name, c.region, c.segment, c.live_openings, c.blockers
    FROM accounts a JOIN companies c ON c.id = a.company_id
    ORDER BY a.priority DESC
  `).all();

  return rows.map((r) => {
    const reasoning = j(r.reasoning);
    const people = db.prepare(
      'SELECT name, title, degree FROM people WHERE company_id = ? ORDER BY degree ASC'
    ).all(r.company_id);
    const best = people[0];

    return [
      r.priority, r.band, r.name, r.region || '', r.segment || '',
      r.fit, r.access, r.timing, r.live_openings || 0, people.length,
      best ? `${best.name} (${best.title || '?'}, ${best.degree === 1 ? '1st' : best.degree === 2 ? '2nd' : 'cold'})` : '',
      arr(r.blockers).join(' | '),
      r.next_action || '',
      (reasoning.fit || []).join(' • '),
      (reasoning.access || []).join(' • '),
      (reasoning.timing || []).join(' • '),
      r.scored_at,
    ];
  });
}

function companyRows(db) {
  return db.prepare('SELECT * FROM companies ORDER BY live_openings DESC, name ASC').all().map((c) => {
    const s = j(c.socials);
    return [
      c.name, c.domain || '', c.region || '', c.segment || '', c.size_band || '',
      c.live_openings || 0, c.ats || '', c.careers_url || '',
      s.linkedin || '', s.instagram || '', s.facebook || '', s.twitter || '',
      s.whatsapp || '', s.email || '', c.openings_checked_at || '',
    ];
  });
}

function peopleRows(db) {
  return db.prepare(`
    SELECT p.*, c.name AS company FROM people p
    LEFT JOIN companies c ON c.id = p.company_id
    ORDER BY p.degree ASC, p.seniority_tier ASC
  `).all().map((p) => [
    p.name, p.title || '', p.seniority_tier || '', p.company || '',
    p.degree === 1 ? '1st' : p.degree === 2 ? '2nd' : 'cold',
    p.connected_on || '', p.source_lane || '', p.linkedin_url || '', p.email || '',
  ]);
}

function draftRows(db) {
  return db.prepare(`
    SELECT d.*, p.name, p.title, p.linkedin_url, c.name AS company,
           a.priority, a.band
    FROM drafts d
    JOIN people p ON p.id = d.person_id
    LEFT JOIN companies c ON c.id = p.company_id
    LEFT JOIN accounts a ON a.company_id = p.company_id
    ORDER BY a.priority DESC
  `).all().map((d, i) => [
    i + 1, d.name, d.company || '', d.title || '', d.priority ?? '', d.band || '',
    d.angle || '', d.status, d.body || '', d.note || '', d.linkedin_url || '',
    '', '', // Sent By Human? / Sent On — the human's columns, never written here
  ]);
}

function actionRows(db, config) {
  const { actions } = dueToday(db, config);
  return actions.map((a) => [
    a.due_on, a.step, a.instruction, a.name, a.title || '', a.company || '',
    a.priority ?? '', a.band || '', a.linkedin_url || '', '',
  ]);
}

// ---------------------------------------------------------------------------

async function renderAll(db, config) {
  const id = config.sheets.spreadsheetId;
  if (!id || id === 'CHANGE_ME') throw new Error('Set sheets.spreadsheetId in config.json.');

  const sheets = await getClient();
  const t = config.sheets.tabs;
  const out = {};

  out.accounts = await writeTab(sheets, id, t.accounts, HEADERS.accounts, accountRows(db));
  out.companies = await writeTab(sheets, id, t.companies, HEADERS.companies, companyRows(db));
  out.people = await writeTab(sheets, id, t.people, HEADERS.people, peopleRows(db));
  out.drafts = await writeTab(sheets, id, t.drafts, HEADERS.drafts, draftRows(db));
  out.actions = await writeTab(sheets, id, t.actions, HEADERS.actions, actionRows(db, config));

  return out;
}

/** Run Log appends rather than replaces — it is history, not a projection. */
async function appendRunLog(config, entry) {
  const sheets = await getClient();
  const id = config.sheets.spreadsheetId;
  const tab = config.sheets.tabs.runLog;

  await ensureTab(sheets, id, tab, HEADERS.runLog);
  await sheets.spreadsheets.values.append({
    spreadsheetId: id, range: `${tab}!A1`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[
      new Date().toISOString(), entry.lane, entry.persona, entry.profilesSeen,
      entry.companiesTouched, entry.accountsScored, entry.bandA, entry.bandB,
      entry.drafts, entry.durationMin, entry.outcome,
    ]] },
  });
}

module.exports = { renderAll, appendRunLog, getClient, HEADERS,
                   accountRows, companyRows, peopleRows, draftRows, actionRows };
