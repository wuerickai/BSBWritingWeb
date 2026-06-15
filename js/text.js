// ────────────────────────────────────────────────────────────────────────────
//  Text utilities: normalization + similarity (duplicate detection) and a
//  word-level diff (for suggested edits / track-changes rendering).
// ────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set('a an the of to in on at for and or is are was were be been being which what that this these those with as by from into out over under it its he she they them his her their your you we our us if then than what whats whose how why when where who whom does do did has have had will would can could should may might must not no yes also such most more less many few all any each both either neither one two three four five'.split(' '));

// Strip LaTeX-ish markup down to comparable words.
function stripLatex(s) {
  return String(s || '')
    .replace(/\\[a-zA-Z]+\s*/g, ' ')   // commands → space
    .replace(/[{}$^_~\\]/g, ' ')       // delimiters
    .replace(/\[[^\]]*\]/g, ' ')       // pronunciation hints like [JIM-no-sperms]
    .toLowerCase();
}

export function normalizeForCompare(s) {
  return stripLatex(s)
    .replace(/[^a-z0-9\s]/g, ' ')      // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(s) {
  return normalizeForCompare(s).split(' ').filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  return inter / (aSet.size + bSet.size - inter);
}

// Word-bigram "shingles" capture phrasing, not just shared vocabulary.
function shingles(toks, n = 2) {
  const s = new Set();
  if (toks.length < n) { toks.forEach((t) => s.add(t)); return s; }
  for (let i = 0; i <= toks.length - n; i++) s.add(toks.slice(i, i + n).join(' '));
  return s;
}

// Overall similarity in [0,1] between two question texts.
export function similarity(aText, bText) {
  const a = tokens(aText), b = tokens(bText);
  if (!a.length || !b.length) return 0;
  const an = normalizeForCompare(aText), bn = normalizeForCompare(bText);
  if (an === bn) return 1;
  const aSet = new Set(a), bSet = new Set(b);
  const tokenJ = jaccard(aSet, bSet);
  const shingleJ = jaccard(shingles(a), shingles(b));
  // containment: a short question fully inside a longer one
  let inter = 0; for (const x of aSet) if (bSet.has(x)) inter++;
  const containment = inter / Math.min(aSet.size, bSet.size);
  // weight phrasing (shingles) and containment a bit higher than raw vocabulary
  return Math.max(0.45 * tokenJ + 0.35 * shingleJ + 0.20 * containment, shingleJ);
}

// Find likely duplicates of `text` among `questions`.
export function findDuplicates(text, questions, { threshold = 0.55, limit = 5, excludeId = null } = {}) {
  if (tokens(text).length < 3) return [];
  const out = [];
  for (const q of questions) {
    if (excludeId && q.id === excludeId) continue;
    const score = similarity(text, q.questionText);
    if (score >= threshold) out.push({ q, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Word-level diff (LCS) for suggested edits ────────────────────────────────
// Tokenize keeping whitespace so the original can be reconstructed faithfully.
function difftokens(s) { return String(s || '').match(/\s+|\S+/g) || []; }

// Returns [{ type:'eq'|'add'|'del', text }]
export function diffWords(oldText, newText) {
  const a = difftokens(oldText), b = difftokens(newText);
  const n = a.length, m = b.length;
  // LCS length table
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('eq', a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; }
    else { push('add', b[j]); j++; }
  }
  while (i < n) { push('del', a[i]); i++; }
  while (j < m) { push('add', b[j]); j++; }
  return out;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Render a word diff as HTML with <ins>/<del>.
export function diffToHtml(oldText, newText) {
  return diffWords(oldText, newText).map((seg) => {
    const t = escapeHtml(seg.text);
    if (seg.type === 'add') return `<ins>${t}</ins>`;
    if (seg.type === 'del') return `<del>${t}</del>`;
    return t;
  }).join('');
}

export function hasChanges(oldText, newText) {
  return (oldText || '') !== (newText || '');
}

// ── Format checkers (Science Bowl style conventions) ─────────────────────────
const NUM_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

// A "pseudo-MC" is a short-answer question presenting a numbered list to
// identify/select/rank, e.g. "... : 1) …; 2) …; 3) …".
export function isPseudoList(text) {
  return (String(text).match(/\b\d\)/g) || []).length >= 2;
}

// Strip LaTeX so we can inspect the plain words of a choice/option.
function plainWords(s) {
  const plain = String(s || '')
    .replace(/\\[a-zA-Z]+\{[^}]*\}/g, ' ')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/[{}\\]/g, ' ');
  return plain.trim().split(/\s+/).filter(Boolean);
}

// Return the first word (after the first) that looks over-capitalized
// (Titlecase like "Theorem"), or null. Acronyms (ALLCAPS) are ignored.
function overCapitalizedWord(option) {
  const words = plainWords(option);
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[^A-Za-z-]/g, '');
    if (/^[A-Z][a-z]+$/.test(w)) return words[i];
  }
  return null;
}

// Returns an array of human-readable warning strings (never blocks).
export function checkFormat(d) {
  const w = [];
  const text = d.questionText || '';

  if (d.type === 'MC') {
    if (!/which of the following/i.test(text)) {
      w.push('Multiple-choice: the question text should contain “which of the following”.');
    }
    for (const slot of ['W', 'X', 'Y', 'Z']) {
      if (slot === d.mcAnswer) continue; // correct option is intentionally ALL CAPS
      const bad = overCapitalizedWord(d.choices?.[slot]);
      if (bad) w.push(`Choice ${slot}: “${bad}” may be over-capitalized — only the first word and proper nouns should be capitalized.`);
    }
  }

  if (isPseudoList(text)) {
    const items = (text.match(/\b\d\)/g) || []).length;
    if (!/^\s*(identify|select|rank)\b/i.test(text)) w.push('List question: start with “Identify”, “Select”, or “Rank”.');
    if (!/all of the following/i.test(text)) w.push('List question: include the phrase “all of the following”.');
    const numMatch = text.toLowerCase().match(/\b(two|three|four|five|six|seven|eight)\b/);
    if (!numMatch) w.push(`List question: state the count as a word (e.g., “${['', '', 'two', 'three', 'four', 'five'][items] || 'three'}”).`);
    else if (NUM_WORDS[numMatch[1]] !== items) w.push(`List question: you wrote “${numMatch[1]}” but there are ${items} numbered items.`);
    if (!/:\s*1\)/.test(text.replace(/\s+/g, ' '))) w.push('List question: put a colon right before “1)” (… that are TRUE: 1) …).');
    if (items >= 2 && !/;\s*\d\)/.test(text.replace(/\s+/g, ' '))) w.push('List question: separate items with semicolons (1) …; 2) …; 3) …).');
  }

  return w;
}
