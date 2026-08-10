/**
 * sheets.js — Google Sheets output.
 *
 * Uses a service account (no browser consent, works unattended, and revoking a
 * client's access is one line in the sheet's share dialog). Setup is in
 * README.md § "Google Sheets API auth".
 *
 * Appends rather than overwrites, and dedupes on LinkedIn profile URL, so the
 * sheet becomes a running pipeline across runs instead of a snapshot that
 * throws away last week's work. Re-scraping a lead updates its score in place.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const LEAD_HEADERS = [
  'Scraped At', 'Name', 'Title', 'Company', 'Location', 'LinkedIn URL',
  'Score', 'Band', 'Seniority', 'Est. Hires/Quarter', 'Live Openings',
  'Careers URL', 'Website', 'ATS Detected', 'Hiring Signal',
  'Scoring Rationale', 'Search Source', 'Next Action',
];

const DRAFT_HEADERS = [
  'Drafted At', 'Rank', 'Name', 'Company', 'Title', 'LinkedIn URL',
  'Score', 'Band', 'Status', 'Message Draft', 'Note', 'Sent By Human? (y/n)', 'Sent On',
];

const RUNLOG_HEADERS = [
  'Run At', 'Persona', 'Searches', 'Cards Seen', 'Profiles Visited',
  'Leads Scored', 'Band A', 'Band B', 'Drafts Written', 'Duration (min)', 'Outcome',
];

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function getClient() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.resolve(__dirname, '..', 'credentials', 'service-account.json');

  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Google service-account key not found at ${keyPath}.\n` +
      'See README.md § "Google Sheets API auth" — it takes about four minutes.'
    );
  }

  const auth = new google.auth.GoogleAuth({ keyFilename: keyPath, scopes: SCOPES });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

async function ensureTab(sheets, spreadsheetId, title, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some((s) => s.properties.title === title);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }

  const first = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${title}!A1:Z1`,
  });

  if (!first.data.values || first.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${title}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
    // Freeze and bold the header row so the sheet is usable by a human.
    const meta2 = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetId = meta2.data.sheets.find((s) => s.properties.title === title).properties.sheetId;
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
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function leadRow(lead, now) {
  return [
    now, lead.name || '', lead.title || '', lead.company || '', lead.location || '',
    lead.url || '', lead.score ?? '', lead.band || '', lead.seniority || '',
    lead.estimatedQuarterlyHires ?? '', lead.openings ?? '',
    lead.careersUrl || '', lead.website || '', lead.atsDetected ? 'yes' : 'no',
    lead.hiringSignal || '', (lead.reasons || []).join(' | '),
    lead.searchSource || '', lead.action || '',
  ];
}

/** Appends new leads; updates rows for URLs already present. */
async function writeLeads(config, leads) {
  const sheets = await getClient();
  const id = config.sheets.spreadsheetId;
  const tab = config.sheets.leadsTab;

  if (!id || id === 'CHANGE_ME') throw new Error('Set sheets.spreadsheetId in config.json.');

  await ensureTab(sheets, id, tab, LEAD_HEADERS);

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${tab}!A:R` });
  const rows = existing.data.values || [];
  const urlCol = LEAD_HEADERS.indexOf('LinkedIn URL');
  const urlToRow = new Map();
  rows.slice(1).forEach((r, i) => { if (r[urlCol]) urlToRow.set(r[urlCol].trim(), i + 2); });

  const now = new Date().toISOString();
  const toAppend = [];
  const updates = [];

  for (const lead of leads) {
    const row = leadRow(lead, now);
    const rowNum = urlToRow.get((lead.url || '').trim());
    if (rowNum) {
      updates.push({ range: `${tab}!A${rowNum}:R${rowNum}`, values: [row] });
    } else {
      toAppend.push(row);
    }
  }

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: { valueInputOption: 'RAW', data: updates },
    });
  }

  if (toAppend.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: id,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAppend },
    });
  }

  return { appended: toAppend.length, updated: updates.length };
}

/** Appends message drafts. Never marks anything as sent — that column is the human's. */
async function writeDrafts(config, drafts) {
  const sheets = await getClient();
  const id = config.sheets.spreadsheetId;
  const tab = config.sheets.draftsTab;

  await ensureTab(sheets, id, tab, DRAFT_HEADERS);

  const now = new Date().toISOString();
  const values = drafts.map((d) => [
    now, d.rank, d.name, d.company, d.title, d.linkedinUrl,
    d.score, d.band, d.status, d.message, d.note, '', '',
  ]);

  if (!values.length) return { appended: 0 };

  await sheets.spreadsheets.values.append({
    spreadsheetId: id,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return { appended: values.length };
}

async function writeRunLog(config, entry) {
  const sheets = await getClient();
  const id = config.sheets.spreadsheetId;
  const tab = config.sheets.runLogTab;

  await ensureTab(sheets, id, tab, RUNLOG_HEADERS);

  await sheets.spreadsheets.values.append({
    spreadsheetId: id,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        new Date().toISOString(), entry.persona, entry.searches, entry.cardsSeen,
        entry.profilesVisited, entry.leadsScored, entry.bandA, entry.bandB,
        entry.draftsWritten, entry.durationMin, entry.outcome,
      ]],
    },
  });
}

module.exports = { writeLeads, writeDrafts, writeRunLog, getClient, LEAD_HEADERS, DRAFT_HEADERS };
