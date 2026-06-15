// ────────────────────────────────────────────────────────────────────────────
//  LaTeX engine: segmenting, validation, and mixed text+math rendering.
//
//  Science Bowl question text mixes plain text, text-mode markup (\textbf, \textit)
//  and inline math ($...$, \(...\), $$...$$, \[...\]), plus bare chemistry
//  (\ce{...}) that the writers put outside math. This module:
//    • segments a string into text vs math chunks (escape-aware),
//    • renders each chunk to safe HTML (KaTeX for math, a small text-mode
//      translator for the rest),
//    • validates the source (brace/delimiter/environment balance + KaTeX parse).
//
//  KaTeX (window.katex) and the mhchem extension are loaded in index.html. If they
//  are unavailable, rendering degrades to escaped source and validation falls back
//  to structural checks only.
// ────────────────────────────────────────────────────────────────────────────

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Return { content, end } where content is the text between matched braces and
// `end` is the index just past the closing brace. `openIdx` must point at '{'.
function extractBraces(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; } // skip escaped char
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { content: s.slice(openIdx + 1, i), end: i + 1, balanced: true };
    }
  }
  return { content: s.slice(openIdx + 1), end: s.length, balanced: false };
}

// Split a string into ordered segments of {type:'text'|'math', content, display}.
// Escape-aware: \$ \( \) \[ \] are handled, \\ is preserved.
export function segmentLatex(src) {
  const segs = [];
  let i = 0;
  const n = src.length;
  let buf = '';
  const flush = () => { if (buf) { segs.push({ type: 'text', content: buf }); buf = ''; } };

  while (i < n) {
    const c = src[i];

    if (c === '\\') {
      const next = src[i + 1];
      if (next === '(') {
        flush();
        const end = src.indexOf('\\)', i + 2);
        if (end === -1) { segs.push({ type: 'math', content: src.slice(i + 2), display: false, unterminated: true }); i = n; }
        else { segs.push({ type: 'math', content: src.slice(i + 2, end), display: false }); i = end + 2; }
        continue;
      }
      if (next === '[') {
        flush();
        const end = src.indexOf('\\]', i + 2);
        if (end === -1) { segs.push({ type: 'math', content: src.slice(i + 2), display: true, unterminated: true }); i = n; }
        else { segs.push({ type: 'math', content: src.slice(i + 2, end), display: true }); i = end + 2; }
        continue;
      }
      // Any other escape (incl. \$, \\, \{, \}, \textbf...) stays in the text buffer.
      buf += c + (next ?? '');
      i += next === undefined ? 1 : 2;
      continue;
    }

    if (c === '$') {
      flush();
      const display = src[i + 1] === '$';
      const delim = display ? '$$' : '$';
      let j = i + delim.length;
      let found = -1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (display) { if (src[j] === '$' && src[j + 1] === '$') { found = j; break; } }
        else if (src[j] === '$') { found = j; break; }
        j++;
      }
      if (found === -1) { segs.push({ type: 'math', content: src.slice(i + delim.length), display, unterminated: true }); i = n; }
      else { segs.push({ type: 'math', content: src.slice(i + delim.length, found), display }); i = found + delim.length; }
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  return segs;
}

function renderMath(tex, display) {
  if (typeof window === 'undefined' || !window.katex) return escapeHtml(tex);
  try {
    return window.katex.renderToString(tex, {
      displayMode: !!display,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'html',
    });
  } catch (e) {
    return `<span class="latex-error" title="${escapeHtml(e.message)}">${escapeHtml(tex)}</span>`;
  }
}

// Text-mode commands we translate to HTML. Everything else is escaped/dropped safely.
const TEXT_WRAPPERS = {
  textbf: 'strong',
  textit: 'em',
  emph: 'em',
  underline: 'u',
  texttt: 'code',
  textsf: 'span',
  textrm: 'span',
  textsc: 'span',
  textsuperscript: 'sup',
  textsubscript: 'sub',
};

function renderTextMode(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];

    if (c === '\\') {
      const m = /^\\([a-zA-Z]+)\s*/.exec(s.slice(i));
      if (m) {
        const cmd = m[1];
        const rest = i + m[0].length;

        // Bare chemistry / physical-units outside math → render via KaTeX+mhchem.
        if ((cmd === 'ce' || cmd === 'pu') && s[rest] === '{') {
          const { content, end } = extractBraces(s, rest);
          out += renderMath(`\\${cmd}{${content}}`, false);
          i = end;
          continue;
        }
        // \pron{...} → bold-italic pronunciation guide wrapped in [brackets].
        if (cmd === 'pron' && s[rest] === '{') {
          const { content, end } = extractBraces(s, rest);
          out += `<strong><em>[${renderTextMode(content)}]</em></strong>`;
          i = end;
          continue;
        }
        if (cmd in TEXT_WRAPPERS && s[rest] === '{') {
          const { content, end } = extractBraces(s, rest);
          const tag = TEXT_WRAPPERS[cmd];
          out += `<${tag}>${renderTextMode(content)}</${tag}>`;
          i = end;
          continue;
        }
        if (cmd === 'textbackslash') { out += '\\'; i = rest; continue; }
        if (cmd === 'degree') { out += '°'; i = rest; continue; }
        // Unknown command: keep its braced argument's content (drop the command).
        if (s[rest] === '{') {
          const { content, end } = extractBraces(s, rest);
          out += renderTextMode(content);
          i = end;
          continue;
        }
        i = rest;
        continue;
      }
      // Escaped punctuation / line breaks.
      const nxt = s[i + 1];
      if (nxt === '\\') { out += '<br>'; i += 2; continue; }
      if (nxt !== undefined && '%&_#${}~ '.includes(nxt)) { out += escapeHtml(nxt); i += 2; continue; }
      out += '\\'; i += 1; continue;
    }

    if (c === '{' || c === '}') { i++; continue; }      // strip stray grouping
    if (c === '~') { out += ' '; i++; continue; }   // non-breaking space
    if (c === '-' && s[i + 1] === '-' && s[i + 2] === '-') { out += '—'; i += 3; continue; }
    if (c === '-' && s[i + 1] === '-') { out += '–'; i += 2; continue; }
    if (c === '`' && s[i + 1] === '`') { out += '“'; i += 2; continue; }
    if (c === "'" && s[i + 1] === "'") { out += '”'; i += 2; continue; }

    out += escapeHtml(c);
    i++;
  }
  return out;
}

// Render mixed LaTeX source to an HTML string (best effort, never throws).
export function renderMixedToString(src) {
  if (!src) return '';
  let html = '';
  for (const seg of segmentLatex(src)) {
    html += seg.type === 'text' ? renderTextMode(seg.content) : renderMath(seg.content, seg.display);
  }
  return html;
}

// Convenience: render into a DOM element.
export function renderInto(el, src) {
  if (!el) return;
  el.innerHTML = renderMixedToString(src);
}

function cleanKatexMsg(msg) {
  return String(msg).replace(/^KaTeX parse error:\s*/, '').replace(/\s+at position \d+/, '');
}

// ── Validation ──────────────────────────────────────────────────────────────
// Returns { ok, errors:[string], warnings:[string] }.
export function validateLatex(src, { allowEmpty = false } = {}) {
  const errors = [];
  const warnings = [];

  if (!src || !src.trim()) {
    if (!allowEmpty) errors.push('Text is empty.');
    return { ok: errors.length === 0, errors, warnings };
  }

  // 1. Brace balance (escape-aware).
  let depth = 0;
  let stray = false;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth < 0) { stray = true; depth = 0; } }
  }
  if (stray) errors.push('Unbalanced braces: a "}" appears with no matching "{".');
  if (depth > 0) errors.push(`Unbalanced braces: ${depth} unclosed "{".`);

  // 2. Inline math "$" parity (escape-aware).
  let dollars = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '$') dollars++;
  }
  if (dollars % 2 !== 0) errors.push('Unbalanced math delimiters: odd number of "$".');

  // 3. \( \) and \[ \] balance.
  const op1 = (src.match(/\\\(/g) || []).length, cl1 = (src.match(/\\\)/g) || []).length;
  if (op1 !== cl1) errors.push(`Unbalanced \\( … \\): ${op1} opening vs ${cl1} closing.`);
  const op2 = (src.match(/\\\[/g) || []).length, cl2 = (src.match(/\\\]/g) || []).length;
  if (op2 !== cl2) errors.push(`Unbalanced \\[ … \\]: ${op2} opening vs ${cl2} closing.`);

  // 4. \begin / \end environment matching.
  const stack = [];
  const reEnv = /\\(begin|end)\{([^}]*)\}/g;
  let m;
  while ((m = reEnv.exec(src))) {
    if (m[1] === 'begin') stack.push(m[2]);
    else {
      const top = stack.pop();
      if (top === undefined) errors.push(`\\end{${m[2]}} has no matching \\begin.`);
      else if (top !== m[2]) errors.push(`Mismatched environment: \\end{${m[2]}} closes \\begin{${top}}.`);
    }
  }
  if (stack.length) errors.push(`Unclosed environment(s): ${stack.map((s) => `\\begin{${s}}`).join(', ')}.`);

  // 5. \left / \right balance.
  const lefts = (src.match(/\\left/g) || []).length, rights = (src.match(/\\right/g) || []).length;
  if (lefts !== rights) errors.push(`Unbalanced \\left and \\right: ${lefts} vs ${rights}.`);

  // 6. KaTeX parse of every math chunk + bare \ce{}/\pu{}.
  if (typeof window !== 'undefined' && window.katex) {
    for (const seg of segmentLatex(src)) {
      if (seg.unterminated) { errors.push('Unterminated math: missing a closing delimiter.'); continue; }
      const chunks = [];
      if (seg.type === 'math') {
        chunks.push(seg.content);
      } else {
        const reChem = /\\(ce|pu)\{/g;
        let cm;
        while ((cm = reChem.exec(seg.content))) {
          const ext = extractBraces(seg.content, cm.index + cm[0].length - 1);
          chunks.push(`\\${cm[1]}{${ext.content}}`);
        }
      }
      for (const tex of chunks) {
        try {
          window.katex.renderToString(tex, { throwOnError: true, strict: false, trust: false });
        } catch (e) {
          errors.push('Math error: ' + cleanKatexMsg(e.message));
        }
      }
    }
  } else {
    warnings.push('KaTeX not loaded — only structural checks were run.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// Validate a whole question (text + answer/choices) at once.
export function validateQuestion(q) {
  const errors = [];
  const push = (label, res) => res.errors.forEach((e) => errors.push(`${label}: ${e}`));

  push('Question text', validateLatex(q.questionText));

  if (q.type === 'SA') {
    push('Answer line', validateLatex(q.answerLine));
  } else if (q.type === 'MC') {
    for (const slot of ['W', 'X', 'Y', 'Z']) {
      push(`Choice ${slot}`, validateLatex(q.choices?.[slot]));
    }
    if (!q.mcAnswer) errors.push('Correct choice: pick which of W/X/Y/Z is correct.');
  }
  return { ok: errors.length === 0, errors };
}

// Uppercase the visible text while leaving LaTeX untouched: math ($…$, \(…\),
// \[…\]) and the commands \ce{}, \pu{}, \pron{} are preserved verbatim, and
// command names (\textbf, etc.) are kept — only their text is uppercased.
// Used to write a correct MC answer in ALL CAPS without corrupting LaTeX.
const PRESERVE_CMDS = new Set(['ce', 'pu', 'pron']);
export function allCapsPreservingLatex(src) {
  if (!src) return src;
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '$') {
      const disp = src[i + 1] === '$';
      const delim = disp ? '$$' : '$';
      let j = i + delim.length, end = -1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (disp) { if (src[j] === '$' && src[j + 1] === '$') { end = j; break; } }
        else if (src[j] === '$') { end = j; break; }
        j++;
      }
      if (end === -1) { out += src.slice(i); break; }
      out += src.slice(i, end + delim.length); i = end + delim.length; continue;
    }
    if (c === '\\') {
      const next = src[i + 1];
      if (next === '(' || next === '[') {
        const close = next === '(' ? '\\)' : '\\]';
        const end = src.indexOf(close, i + 2);
        if (end === -1) { out += src.slice(i); break; }
        out += src.slice(i, end + 2); i = end + 2; continue;
      }
      const m = /^\\([a-zA-Z]+)/.exec(src.slice(i));
      if (m) {
        if (PRESERVE_CMDS.has(m[1]) && src[i + m[0].length] === '{') {
          const { end } = extractBraces(src, i + m[0].length);
          out += src.slice(i, end); i = end; continue;     // keep \ce{…}/\pron{…} verbatim
        }
        out += m[0]; i += m[0].length; continue;            // keep command name; uppercase its args
      }
      out += src.slice(i, i + 2); i += 2; continue;          // escaped char e.g. \%
    }
    out += c.toUpperCase(); i++;
  }
  return out;
}
