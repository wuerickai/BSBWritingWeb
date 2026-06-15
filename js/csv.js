// ────────────────────────────────────────────────────────────────────────────
//  CSV parsing + mapping for bulk import. Accepts the same column layout as the
//  Master Sheet:
//    TU/B, Subject, Type, Subcat, Question Text, IF SA - Answer Line,
//    W, X, Y, Z, IF MC - Answer, Difficulty, Status, ID, Source, Writer Initials
// ────────────────────────────────────────────────────────────────────────────

// RFC-4180-ish CSV parser (handles quotes, escaped quotes, commas + newlines in fields).
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQuotes = false;
  const n = text.length;
  // strip BOM
  if (text.charCodeAt(0) === 0xFEFF) i = 1;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  // last field/row
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const SLOTS = ['W', 'X', 'Y', 'Z'];

// Normalize a header cell for fuzzy matching.
const normHead = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const HEADER_ALIASES = {
  tub: ['tub', 'tu/b', 'tub', 'tossupbonus', 'tossupbonus'],
  subject: ['subject'],
  type: ['type'],
  subcat: ['subcat', 'subcategory'],
  questionText: ['questiontext', 'question'],
  answerLine: ['ifsaanswerline', 'answerline', 'answer', 'safanswer', 'ifsaanswer'],
  W: ['w'], X: ['x'], Y: ['y'], Z: ['z'],
  mcAnswer: ['ifmcanswer', 'mcanswer', 'correct', 'answermc'],
  difficulty: ['difficulty', 'diff'],
  status: ['status'],
  id: ['id'],
  source: ['source'],
  writerInitials: ['writerinitials', 'initials', 'writer'],
};

function buildHeaderMap(headerRow) {
  const normed = headerRow.map(normHead);
  const map = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = normed.findIndex((h) => aliases.includes(h));
    if (idx >= 0) map[key] = idx;
  }
  return map;
}

const intOrNull = (v) => {
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
};

// Parse a CSV string into question drafts. Returns { questions, headerMap, missing }.
export function csvToQuestions(text) {
  const rows = parseCSV(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!rows.length) return { questions: [], headerMap: {}, missing: ['(file is empty)'] };
  const headerMap = buildHeaderMap(rows[0]);
  const get = (row, key) => (headerMap[key] != null ? (row[headerMap[key]] ?? '').trim() : '');

  const required = ['questionText', 'subject'];
  const missing = required.filter((k) => headerMap[k] == null);

  const questions = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const questionText = get(row, 'questionText');
    const subject = get(row, 'subject');
    if (!questionText && !subject) continue;
    const type = get(row, 'type').toUpperCase();
    questions.push({
      tub: get(row, 'tub').toUpperCase(),
      subject,
      type,
      subcat: get(row, 'subcat'),
      questionText,
      answerLine: type === 'SA' ? get(row, 'answerLine') : '',
      choices: Object.fromEntries(SLOTS.map((s) => [s, get(row, s)])),
      mcAnswer: type === 'MC' ? get(row, 'mcAnswer').toUpperCase() : '',
      difficulty: intOrNull(get(row, 'difficulty')),
      source: get(row, 'source'),
      writerInitials: get(row, 'writerInitials').toUpperCase(),
      csvId: intOrNull(get(row, 'id')),
      _rowNum: r + 1,
    });
  }

  // Collapse duplicate sheet-IDs (the master sheet repeats a row per review pass) —
  // keep the last occurrence (latest text).
  const byId = new Map();
  const noId = [];
  for (const q of questions) {
    if (q.csvId == null) noId.push(q);
    else byId.set(q.csvId, q);
  }
  const collapsed = [...byId.values(), ...noId];
  return { questions: collapsed, headerMap, missing };
}
