// ────────────────────────────────────────────────────────────────────────────
//  Main application: bootstrap, auth screens, router, and the five views
//  (Write, My Questions, Review Queue, Finalized, Admin).
// ────────────────────────────────────────────────────────────────────────────

import { CONFIG } from './config.js';
import { initStore, S, backendKind } from './store/index.js';
import * as T from './taxonomy.js';
import { validateLatex, validateQuestion, renderInto, renderMixedToString, allCapsPreservingLatex } from './latex.js';
import { findDuplicates, diffToHtml, hasChanges, checkFormat } from './text.js';
import { csvToQuestions } from './csv.js';
import * as Backup from './backup.js';
import {
  el, clear, fillSelect, toast, modal, confirmDialog, fmtDate, stateBadge, debounce, STATE_META,
} from './ui.js';

const app = { user: null, unsub: null, allQuestions: [], allUnsub: null };
const view = () => document.getElementById('view');
const ROUTES = ['write', 'mine', 'review', 'finalized', 'admin'];

// ── Bootstrap ─────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', boot);

// Turn raw Firebase/JS errors into a short, actionable message.
function explainError(err) {
  const code = (err && (err.code || err.name)) || '';
  const hints = {
    'permission-denied': 'Database permission denied — publish firestore.rules and make sure your account is approved.',
    'unavailable': 'Can’t reach Firestore — is the database created in the Firebase console?',
    'not-found': 'Firestore database not found — create it in the Firebase console.',
    'failed-precondition': 'Firestore isn’t ready (create the database in the console).',
    'resource-exhausted': 'Firestore quota exceeded for now.',
    'auth/operation-not-allowed': 'Enable Email/Password under Firebase → Authentication → Sign-in method.',
    'auth/unauthorized-domain': 'Add this site’s domain under Firebase → Authentication → Settings → Authorized domains.',
    'auth/network-request-failed': 'Network error reaching Firebase (check your connection / domain).',
    'auth/email-already-in-use': 'That email already has an account — try signing in instead.',
    'auth/invalid-email': 'That email address looks invalid.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/user-not-found': 'No account found with that email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/too-many-requests': 'Too many attempts — wait a moment and try again.',
  };
  return hints[code] || (err && err.message) || String(err);
}

async function boot() {
  document.title = CONFIG.appName;
  document.getElementById('brand-name').textContent = CONFIG.appName;
  // Safety net: surface any otherwise-silent async failure from a button handler.
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled error:', e.reason);
    toast(explainError(e.reason), 'error');
  });

  if (backendKind() === 'firebase' && !CONFIG.firebase.apiKey) {
    renderFatal('Firebase is selected but not configured. Open js/config.js and paste your Firebase web-app config (or set backend to "local" to use the demo).');
    return;
  }

  try {
    await initStore();
  } catch (e) {
    renderFatal('Could not initialize the backend: ' + e.message);
    return;
  }

  S().onAuthChange((user) => { app.user = user; render(); });
  window.addEventListener('hashchange', () => { if (isReady()) routeTo(currentRoute()); });
}

const APPROVED_ROLES = ['writer', 'reviewer', 'admin'];
function isApprovedRole(role) { return APPROVED_ROLES.includes(role); }
function isReady() {
  return app.user && (!CONFIG.requireEmailVerification || app.user.emailVerified) && isApprovedRole(app.user.role);
}
function currentRoute() {
  const r = (location.hash || '').replace(/^#\/?/, '');
  return ROUTES.includes(r) ? r : 'write';
}
function navigate(r) { location.hash = '#/' + r; }

function cleanupSub() { if (app.unsub) { try { app.unsub(); } catch {} app.unsub = null; } }

// A session-long subscription to ALL questions, powering duplicate detection and
// periodic backups. Started once the user is ready; torn down on sign-out.
let _backupStarted = false;
function startGlobal() {
  if (app.allUnsub) return;
  app.allUnsub = S().watchQuestions({}, (rows) => {
    app.allQuestions = rows;
    Backup.markDirty();
    document.dispatchEvent(new CustomEvent('sbq-allquestions'));
  });
  if (!_backupStarted) { Backup.start(() => app.allQuestions); _backupStarted = true; }
}
function stopGlobal() {
  if (app.allUnsub) { try { app.allUnsub(); } catch {} app.allUnsub = null; }
  Backup.stop(); _backupStarted = false;
  app.allQuestions = [];
}

// ── Top-level render ───────────────────────────────────────────────────────────
function render() {
  cleanupSub();
  renderHeader();
  if (!app.user) { stopGlobal(); renderAuth(); return; }
  if (CONFIG.requireEmailVerification && !app.user.emailVerified) { stopGlobal(); renderVerify(); return; }
  if (!isApprovedRole(app.user.role)) { stopGlobal(); renderPending(); return; }
  startGlobal();
  routeTo(currentRoute());
}

// Cached count of users awaiting approval, shown as a badge on the Admin tab.
let _pending = { at: 0, n: 0 };
function invalidatePending() { _pending.at = 0; }
async function updateAdminBadge(anchor) {
  try {
    if (Date.now() - _pending.at > 8000) {
      const us = await S().listUsers();
      _pending = { at: Date.now(), n: us.filter((u) => u.role === 'pending').length };
    }
    if (_pending.n > 0 && anchor.isConnected) anchor.appendChild(el('span', { class: 'nav-badge', text: String(_pending.n) }));
  } catch {}
}

function renderHeader() {
  const bar = document.getElementById('topbar');
  clear(bar);
  const left = el('div', { class: 'brand' }, [
    el('span', { class: 'brand-mark', text: 'Σ' }),
    el('span', { id: 'brand-name', text: CONFIG.appName }),
  ]);
  bar.appendChild(left);

  if (isReady()) {
    const tabs = [
      ['write', '✎ Write'],
      ['mine', '◳ My Questions'],
      ['review', '⚖ Review Queue'],
      ['finalized', '★ Finalized'],
    ];
    if (app.user.role === 'admin') tabs.push(['admin', '⚙ Admin']);
    const nav = el('nav', { class: 'tabs' });
    const cur = currentRoute();
    let adminAnchor = null;
    for (const [r, label] of tabs) {
      const a = el('a', { class: 'tab' + (r === cur ? ' active' : ''), href: '#/' + r, text: label });
      if (r === 'admin') adminAnchor = a;
      nav.appendChild(a);
    }
    bar.appendChild(nav);
    if (adminAnchor) updateAdminBadge(adminAnchor);
  }

  if (app.user) {
    const roleTag = app.user.role !== 'writer' ? el('span', { class: 'role-tag', text: app.user.role }) : null;
    const menu = el('div', { class: 'usermenu' }, [
      roleTag,
      el('span', { class: 'user-email', text: app.user.email }),
      el('button', { class: 'btn ghost sm', text: 'Sign out', onclick: async () => { await S().signOutUser(); navigate('write'); } }),
    ]);
    bar.appendChild(menu);
  }
}

function renderFatal(msg) {
  document.getElementById('topbar').innerHTML = '';
  clear(view()).appendChild(el('div', { class: 'card center-card' }, [
    el('h2', { text: 'Setup needed' }),
    el('p', { text: msg }),
  ]));
}

// ── Auth screens ────────────────────────────────────────────────────────────────
function renderAuth() {
  const host = clear(view());
  let mode = 'in'; // 'in' | 'up'

  const card = el('div', { class: 'card auth-card' });
  const draw = () => {
    clear(card);
    card.appendChild(el('div', { class: 'auth-tabs' }, [
      el('button', { class: 'auth-tab' + (mode === 'in' ? ' active' : ''), text: 'Sign in', onclick: () => { mode = 'in'; draw(); } }),
      el('button', { class: 'auth-tab' + (mode === 'up' ? ' active' : ''), text: 'Create account', onclick: () => { mode = 'up'; draw(); } }),
    ]));

    const email = el('input', { class: 'inp', type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
    const pw = el('input', { class: 'inp', type: 'password', placeholder: 'Password', autocomplete: mode === 'up' ? 'new-password' : 'current-password' });
    const name = el('input', { class: 'inp', placeholder: 'Display name (e.g. Harini A.)' });
    const initials = el('input', { class: 'inp', placeholder: 'Writer initials (e.g. HA)', maxLength: 5 });
    const msg = el('div', { class: 'form-msg' });

    const fields = [field('Email', email), field('Password', pw)];
    if (mode === 'up') { fields.push(field('Display name', name), field('Initials', initials)); }

    const submit = el('button', { class: 'btn primary block', text: mode === 'in' ? 'Sign in' : 'Create account' });
    const doIt = async () => {
      msg.className = 'form-msg';
      msg.textContent = '';
      submit.disabled = true;
      try {
        if (mode === 'in') await S().signIn({ email: email.value, password: pw.value });
        else {
          await S().signUp({ email: email.value, password: pw.value, displayName: name.value, initials: initials.value });
          if (CONFIG.requireEmailVerification) toast('Account created — check your email to verify.', 'success');
        }
      } catch (e) {
        msg.className = 'form-msg error';
        msg.textContent = explainError(e);
      } finally { submit.disabled = false; }
    };
    submit.addEventListener('click', doIt);
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doIt(); });

    const forgot = el('button', {
      class: 'linklike', text: 'Forgot password?', onclick: async () => {
        if (!email.value) { msg.className = 'form-msg error'; msg.textContent = 'Enter your email first.'; return; }
        try { await S().resetPassword(email.value); msg.className = 'form-msg success'; msg.textContent = 'Password reset email sent (if the account exists).'; }
        catch (e) { msg.className = 'form-msg error'; msg.textContent = e.message; }
      },
    });

    card.appendChild(el('div', { class: 'auth-body' }, [...fields, msg, submit, mode === 'in' ? forgot : null]));
  };
  draw();

  host.appendChild(el('div', { class: 'auth-wrap' }, [
    el('div', { class: 'auth-hero' }, [
      el('h1', { text: CONFIG.appName }),
      el('p', { text: 'Write, review, and finalize Science Bowl questions — with LaTeX checking and a structured review workflow.' }),
      backendKind() === 'local' ? el('p', { class: 'demo-note', text: 'Demo mode: accounts live only in this browser. Edit js/config.js to connect Firebase for real, secure, shared accounts.' }) : null,
    ]),
    card,
  ]));
}

function renderVerify() {
  const host = clear(view());
  const msg = el('div', { class: 'form-msg' });
  const actions = el('div', { class: 'col-gap' });

  actions.appendChild(el('button', {
    class: 'btn ghost', text: 'I have verified — refresh', onclick: async () => {
      await S().reloadUser();
      if (!app.user?.emailVerified) { msg.className = 'form-msg error'; msg.textContent = 'Still not verified. Click the link in your email, then try again.'; }
    },
  }));
  actions.appendChild(el('button', {
    class: 'btn ghost', text: 'Resend verification email', onclick: async () => {
      try { await S().sendVerification(); msg.className = 'form-msg success'; msg.textContent = 'Verification email sent.'; }
      catch (e) { msg.className = 'form-msg error'; msg.textContent = e.message; }
    },
  }));
  // Demo-only shortcut.
  if (S().devVerify) {
    actions.appendChild(el('button', {
      class: 'btn primary', text: '(Demo) Simulate clicking the email link', onclick: async () => { await S().devVerify(); },
    }));
  }

  host.appendChild(el('div', { class: 'card center-card' }, [
    el('h2', { text: 'Verify your email' }),
    el('p', { html: `We sent a verification link to <strong>${app.user.email}</strong>. Verify it to start writing and reviewing.` }),
    actions, msg,
    el('button', { class: 'linklike', text: 'Sign out', style: 'margin-top:14px', onclick: () => S().signOutUser() }),
  ]));
}

function renderPending() {
  const host = clear(view());
  const declined = app.user.role === 'rejected';
  const msg = el('div', { class: 'form-msg' });
  const actions = el('div', { class: 'col-gap' });
  if (!declined) {
    actions.appendChild(el('button', {
      class: 'btn primary', text: 'Check again', onclick: async () => {
        await S().reloadUser();
        if (!isApprovedRole(app.user?.role)) { msg.className = 'form-msg'; msg.textContent = 'Still waiting — an admin hasn’t approved your account yet.'; }
      },
    }));
  }
  actions.appendChild(el('button', { class: 'btn ghost', text: 'Sign out', onclick: () => S().signOutUser() }));

  host.appendChild(el('div', { class: 'card center-card' }, [
    el('div', { class: 'gate-icon', text: declined ? '⛔' : '⏳' }),
    el('h2', { text: declined ? 'Access not granted' : 'Waiting for approval' }),
    declined
      ? el('p', { html: `An administrator declined access for <strong>${app.user.email}</strong>. If you think this is a mistake, contact an admin.` })
      : el('p', { html: `Your account <strong>${app.user.email}</strong> is verified and is now waiting for an administrator to approve it. You’ll get access as soon as they do.` }),
    actions, msg,
  ]));
}

function field(label, input) {
  return el('label', { class: 'field' }, [el('span', { class: 'field-label', text: label }), input]);
}

// ── Router ────────────────────────────────────────────────────────────────────
function routeTo(route) {
  cleanupSub();
  renderHeader();
  switch (route) {
    case 'write': return viewWrite();
    case 'mine': return viewMine();
    case 'review': return viewReview();
    case 'finalized': return viewFinalized();
    case 'admin': return app.user.role === 'admin' ? viewAdmin() : viewWrite();
    default: return viewWrite();
  }
}

// ── Reusable question form ───────────────────────────────────────────────────────
function buildQuestionForm(initial = {}) {
  const tub = el('select', { class: 'inp' });
  fillSelect(tub, T.TUB, { value: (x) => x.value, label: (x) => x.label, selected: initial.tub, placeholder: 'Select…' });

  const subject = el('select', { class: 'inp' });
  fillSelect(subject, T.SUBJECTS, { selected: initial.subject, placeholder: 'Select…' });

  const subcat = el('select', { class: 'inp' });
  const fillSub = (subj, sel) => fillSelect(subcat, T.subcatsFor(subj), { selected: sel, placeholder: subj ? 'Select…' : 'Pick a subject first' });
  fillSub(initial.subject, initial.subcat);
  subject.addEventListener('change', () => fillSub(subject.value, null));

  const type = el('select', { class: 'inp' });
  fillSelect(type, T.TYPES, { value: (x) => x.value, label: (x) => x.label, selected: initial.type, placeholder: 'Select…' });

  const difficulty = el('select', { class: 'inp' });
  fillSelect(difficulty, T.DIFFICULTIES, { value: (x) => x.value, label: (x) => x.label, selected: initial.difficulty, placeholder: 'Select…' });

  const source = el('input', { class: 'inp', value: initial.source || '', placeholder: 'Optional: URL or citation' });
  const writerName = el('input', { class: 'inp', value: initial.writerName ?? app.user?.displayName ?? '' });
  const writerInitials = el('input', { class: 'inp', value: initial.writerInitials ?? app.user?.initials ?? '', maxLength: 5, placeholder: 'e.g. HA' });

  // Question text + live preview + validation.
  const qText = el('textarea', { class: 'inp mono', rows: 5, value: initial.questionText || '', placeholder: 'Question text. LaTeX OK: $\\rho(r)$, \\textbf{bold}, \\ce{H2O}, $^\\circ$C, \\pron{pruh-NUN-see-AY-shun} …' });
  const qPreview = el('div', { class: 'preview' });
  const qStatus = el('div', { class: 'val-status' });

  // Short answer.
  const answerLine = el('input', { class: 'inp mono', value: initial.answerLine || '', placeholder: 'Accepted answer(s)' });
  const answerPreview = el('div', { class: 'preview sm' });
  const saWrap = el('div', { class: 'subsection' }, [
    field('Answer line (SA)', answerLine), labeled('Preview', answerPreview),
  ]);

  // Multiple choice.
  const choiceInputs = {}; const choicePreviews = {};
  const mcRows = el('div', { class: 'mc-grid' });
  for (const slot of T.MC_SLOTS) {
    const inp = el('input', { class: 'inp mono', value: initial.choices?.[slot] || '', placeholder: `Choice ${slot}` });
    const prev = el('div', { class: 'preview sm' });
    choiceInputs[slot] = inp; choicePreviews[slot] = prev;
    mcRows.appendChild(el('div', { class: 'mc-row' }, [el('span', { class: 'mc-slot', text: slot }), el('div', { class: 'mc-fields' }, [inp, prev])]));
  }
  const mcAnswer = el('select', { class: 'inp' });
  fillSelect(mcAnswer, T.MC_SLOTS, { selected: initial.mcAnswer, placeholder: 'Which choice is correct?' });
  const mcWrap = el('div', { class: 'subsection' }, [el('h4', { text: 'Choices' }), mcRows, field('Correct answer (MC)', mcAnswer)]);

  const setType = () => {
    const t = type.value;
    saWrap.style.display = t === 'SA' ? '' : 'none';
    mcWrap.style.display = t === 'MC' ? '' : 'none';
  };
  type.addEventListener('change', setType);
  setType();

  // Live previews + validation.
  const showVal = () => {
    const res = validateLatex(qText.value, { allowEmpty: true });
    clear(qStatus);
    if (!qText.value.trim()) { qStatus.className = 'val-status'; return; }
    if (res.ok) { qStatus.className = 'val-status ok'; qStatus.textContent = '✓ LaTeX looks valid'; }
    else { qStatus.className = 'val-status bad'; qStatus.appendChild(el('span', { text: '✕ ' + res.errors[0] })); }
  };
  // Duplicate detection panel.
  const dupHost = el('div', { class: 'dup-host' });
  const updateDupes = () => {
    const matches = findDuplicates(qText.value, app.allQuestions, { threshold: CONFIG.duplicate.show, excludeId: initial.id || null, limit: 4 });
    clear(dupHost);
    if (!matches.length) return;
    dupHost.appendChild(el('div', { class: 'dup-box' }, [
      el('div', { class: 'dup-title', text: `⚠ ${matches.length} possible duplicate${matches.length > 1 ? 's' : ''} already in the bank` }),
      ...matches.map(({ q, score }) => el('div', { class: 'dup-item' }, [
        el('span', { class: 'dup-score', text: Math.round(score * 100) + '%' }),
        el('span', { class: 'dup-id', text: '#' + q.humanId }),
        stateBadge(q.state),
        el('span', { class: 'dup-text', html: renderMixedToString(q.questionText).slice(0, 200) }),
        el('button', { class: 'btn ghost xs', text: 'View', onclick: () => modal(`Question #${q.humanId}`, questionDetail(q), { wide: true }) }),
      ])),
    ]));
  };

  const liveQ = debounce(() => { renderInto(qPreview, qText.value); showVal(); updateDupes(); }, 250);
  qText.addEventListener('input', liveQ);
  answerLine.addEventListener('input', debounce(() => renderInto(answerPreview, answerLine.value), 200));
  for (const slot of T.MC_SLOTS) {
    choiceInputs[slot].addEventListener('input', debounce(() => renderInto(choicePreviews[slot], choiceInputs[slot].value), 200));
  }
  // initial paint
  renderInto(qPreview, qText.value); showVal(); updateDupes();
  renderInto(answerPreview, answerLine.value);
  for (const slot of T.MC_SLOTS) renderInto(choicePreviews[slot], choiceInputs[slot].value);

  const node = el('div', { class: 'qform' }, [
    el('div', { class: 'grid-4' }, [
      field('Toss-Up / Bonus', tub), field('Subject', subject), field('Subcategory', subcat), field('Type', type),
    ]),
    field('Question text', qText),
    el('div', { class: 'preview-wrap' }, [el('div', { class: 'preview-label', text: 'Live preview' }), qPreview, qStatus]),
    dupHost,
    saWrap, mcWrap,
    el('div', { class: 'grid-3' }, [
      field('Difficulty', difficulty), field('Writer name', writerName), field('Writer initials', writerInitials),
    ]),
    field('Source', source),
  ]);

  const collect = () => ({
    tub: tub.value, subject: subject.value, subcat: subcat.value, type: type.value,
    questionText: qText.value, answerLine: answerLine.value,
    choices: Object.fromEntries(T.MC_SLOTS.map((s) => [s, choiceInputs[s].value])),
    mcAnswer: mcAnswer.value,
    difficulty: difficulty.value ? Number(difficulty.value) : null,
    source: source.value, writerName: writerName.value, writerInitials: writerInitials.value,
  });

  return { node, collect };
}

function labeled(label, node) {
  return el('div', { class: 'field' }, [el('span', { class: 'field-label', text: label }), node]);
}

// Required-field + LaTeX validation. Returns array of error strings.
function validateForm(d) {
  const errors = [];
  if (!d.tub) errors.push('Choose Toss-Up or Bonus.');
  if (!d.subject) errors.push('Choose a subject.');
  if (!d.subcat) errors.push('Choose a subcategory.');
  if (!d.type) errors.push('Choose a type (MC or SA).');
  if (!d.difficulty) errors.push('Choose a difficulty.');
  if (!d.questionText.trim()) errors.push('Question text is empty.');
  if (d.type === 'SA' && !d.answerLine.trim()) errors.push('Provide an answer line.');
  if (d.type === 'MC') {
    for (const s of T.MC_SLOTS) if (!d.choices[s]?.trim()) errors.push(`Choice ${s} is empty.`);
    if (!d.mcAnswer) errors.push('Select which choice (W/X/Y/Z) is correct.');
  }
  const v = validateQuestion(d);
  errors.push(...v.errors);
  return errors;
}

function errorBox(errors) {
  return el('div', { class: 'err-box' }, [
    el('strong', { text: errors.length === 1 ? '1 issue to fix:' : `${errors.length} issues to fix:` }),
    el('ul', {}, errors.map((e) => el('li', { text: e }))),
  ]);
}

// Auto-formatting applied on save/submit: write the correct MC answer in ALL CAPS
// (preserving any LaTeX). Returns a new data object; never mutates the original.
function applyAutoFormat(data) {
  const out = { ...data, choices: { ...(data.choices || {}) } };
  if (out.type === 'MC' && out.mcAnswer && out.choices[out.mcAnswer]) {
    out.choices[out.mcAnswer] = allCapsPreservingLatex(out.choices[out.mcAnswer]);
  }
  return out;
}

// Static list of conventions, shown as a checklist in the reminder box.
const CONVENTIONS = [
  'Multiple-choice stems include “which of the following”.',
  'In MC options, capitalize only the first word and proper nouns.',
  'The correct MC answer is saved in ALL CAPS (done automatically).',
  'List questions: “Identify/Select/Rank all of the following <number> … that are <TRUE/…>: 1) …; 2) …; 3) .”',
  'Pronunciations use \\pron{…} → renders as a bold-italic [guide].',
];

// Reminder box shown before submitting. Applies auto-format, runs the format
// checkers, shows possible duplicates + the conventions checklist, and resolves
// to the (formatted) data to save, or null if the writer backs out.
function preSubmit(rawData, { excludeId = null, verb = 'Submit' } = {}) {
  const data = applyAutoFormat(rawData);
  const warnings = checkFormat(data);
  const dups = findDuplicates(data.questionText, app.allQuestions, { threshold: CONFIG.duplicate.confirm, excludeId, limit: 3 });

  return new Promise((resolve) => {
    const sections = [];

    if (warnings.length) {
      sections.push(el('div', { class: 'remind-block warn' }, [
        el('h4', { text: `⚠ ${warnings.length} formatting thing${warnings.length > 1 ? 's' : ''} to double-check` }),
        el('ul', {}, warnings.map((wn) => el('li', { text: wn }))),
      ]));
    }

    if (dups.length) {
      sections.push(el('div', { class: 'remind-block warn' }, [
        el('h4', { text: 'Possible duplicate(s) already in the bank' }),
        el('div', { class: 'dup-box' }, dups.map(({ q, score }) => el('div', { class: 'dup-item' }, [
          el('span', { class: 'dup-score', text: Math.round(score * 100) + '%' }),
          el('span', { class: 'dup-id', text: '#' + q.humanId }),
          stateBadge(q.state),
          el('span', { class: 'dup-text', html: renderMixedToString(q.questionText).slice(0, 160) }),
        ]))),
      ]));
    }

    if (data.type === 'MC' && data.mcAnswer && data.choices[data.mcAnswer]) {
      sections.push(el('div', { class: 'remind-block' }, [
        el('h4', { text: 'Correct answer will be saved as' }),
        el('div', { class: 'preview', html: renderMixedToString(data.choices[data.mcAnswer]) }),
      ]));
    }

    sections.push(el('div', { class: 'remind-block' }, [
      el('h4', { text: 'Formatting reminders' }),
      el('ul', { class: 'remind-conventions' }, CONVENTIONS.map((cv) => el('li', { text: cv }))),
    ]));

    sections.push(el('div', { class: 'row-end gap', style: 'margin-top:16px' }, [
      el('button', { class: 'btn ghost', text: 'Go back & edit', onclick: () => { m.close(); resolve(null); } }),
      el('button', { class: warnings.length || dups.length ? 'btn warn' : 'btn primary', text: `${verb} anyway`, onclick: () => { m.close(); resolve(data); } }),
    ]));

    const m = modal('Before you submit', el('div', {}, sections), { wide: true });
  });
}

// ── View: Write ──────────────────────────────────────────────────────────────────
function viewWrite() {
  const host = clear(view());
  const form = buildQuestionForm({});
  const msgHost = el('div', {});

  const finish = (errors) => { clear(msgHost); if (errors.length) msgHost.appendChild(errorBox(errors)); };

  const saveDraft = el('button', {
    class: 'btn ghost', text: 'Save as draft', onclick: async () => {
      const d = form.collect();
      // Drafts only need a few basics; full validation happens on submit.
      if (!d.subject && !d.questionText.trim()) { finish(['Add at least a subject or some question text before saving.']); return; }
      await S().createQuestion(d);
      toast('Draft saved. Find it under “My Questions”.', 'success');
      navigate('mine');
    },
  });

  const submit = el('button', {
    class: 'btn primary', text: 'Submit for review', onclick: async () => {
      const d = form.collect();
      const errors = validateForm(d);
      finish(errors);
      if (errors.length) { toast('Fix the highlighted issues first.', 'error'); return; }
      const formatted = await preSubmit(d);
      if (!formatted) return;
      const q = await S().createQuestion(formatted);
      await S().submitForReview(q.id);
      toast('Submitted for review!', 'success');
      navigate('mine');
    },
  });

  host.appendChild(el('div', { class: 'page' }, [
    el('div', { class: 'page-head' }, [el('h1', { text: 'Write a question' }), el('p', { class: 'muted', text: 'Compose in LaTeX, preview live, then submit to the review queue.' })]),
    el('div', { class: 'card' }, [form.node, msgHost, el('div', { class: 'row-end gap', style: 'margin-top:18px' }, [saveDraft, submit])]),
  ]));
}

// ── Editing existing draft / returned question ───────────────────────────────────
function openEditor(q) {
  const form = buildQuestionForm(q);
  const msgHost = el('div', {});
  const finish = (errors) => { clear(msgHost); if (errors.length) msgHost.appendChild(errorBox(errors)); };

  const inReview = q.state === 'in_review';
  const isReturned = q.state === 'changes_requested';
  const titles = { draft: `Edit draft #${q.humanId}`, changes_requested: `Revise question #${q.humanId}`, in_review: `Edit question #${q.humanId}` };

  const note = inReview ? el('p', { class: 'muted sm', text: 'This question is in review — your edits are visible to reviewers right away, and the review count won’t change.' }) : null;
  const body = el('div', {}, [note, form.node, msgHost]);
  const m = modal(titles[q.state] || `Edit #${q.humanId}`, body, { wide: true });

  const buttons = [];
  if (inReview) {
    buttons.push(el('button', {
      class: 'btn primary', text: 'Save edits', onclick: async () => {
        const d = form.collect();
        const errors = validateForm(d);
        finish(errors);
        if (errors.length) { toast('Fix the highlighted issues first.', 'error'); return; }
        const formatted = await preSubmit(d, { excludeId: q.id, verb: 'Save' });
        if (!formatted) return;
        await S().updateDraft(q.id, formatted);
        toast('Edits saved.', 'success'); m.close();
      },
    }));
  } else {
    buttons.push(el('button', {
      class: 'btn ghost', text: 'Save without submitting', onclick: async () => {
        await S().updateDraft(q.id, applyAutoFormat(form.collect()));
        toast('Saved.', 'success'); m.close();
      },
    }));
    buttons.push(el('button', {
      class: 'btn primary', text: isReturned ? 'Resubmit for review' : 'Submit for review', onclick: async () => {
        const d = form.collect();
        const errors = validateForm(d);
        finish(errors);
        if (errors.length) { toast('Fix the highlighted issues first.', 'error'); return; }
        const formatted = await preSubmit(d, { excludeId: q.id, verb: isReturned ? 'Resubmit' : 'Submit' });
        if (!formatted) return;
        await S().submitForReview(q.id, formatted);
        toast(isReturned ? 'Resubmitted for review.' : 'Submitted for review.', 'success');
        m.close();
      },
    }));
  }
  body.appendChild(el('div', { class: 'row-end gap', style: 'margin-top:18px' }, buttons));
}

// ── Question detail (read-only render) ───────────────────────────────────────────
function questionDetail(q) {
  const meta = el('div', { class: 'meta-grid' }, [
    metaItem('ID', '#' + q.humanId),
    metaItem('Type', `${q.tub} · ${q.type}`),
    metaItem('Subject', q.subject),
    metaItem('Subcategory', q.subcat),
    metaItem('Difficulty', q.difficulty ?? '—'),
    metaItem('Status (reviews)', q.status),
    metaItem('Writer', `${q.writerName || '—'}${q.writerInitials ? ' (' + q.writerInitials + ')' : ''}`),
    metaItemNode('State', stateBadge(q.state)),
  ]);

  const qBody = el('div', { class: 'render-block', html: renderMixedToString(q.questionText) });

  let answerBlock;
  if (q.type === 'MC') {
    answerBlock = el('div', { class: 'choices' }, T.MC_SLOTS.map((s) => el('div', {
      class: 'choice' + (q.mcAnswer === s ? ' correct' : ''),
    }, [el('span', { class: 'choice-key', text: s }), el('span', { class: 'choice-text', html: renderMixedToString(q.choices?.[s] || '') }), q.mcAnswer === s ? el('span', { class: 'choice-flag', text: '✓ correct' }) : null])));
  } else {
    answerBlock = el('div', { class: 'answer-line' }, [el('span', { class: 'answer-key', text: 'Answer:' }), el('span', { html: renderMixedToString(q.answerLine || '') })]);
  }

  const children = [
    meta,
    el('h4', { text: 'Question' }), qBody,
    el('h4', { text: q.type === 'MC' ? 'Choices' : 'Answer' }), answerBlock,
  ];
  if (q.source) children.push(el('p', { class: 'source-line' }, [el('strong', { text: 'Source: ' }), el('span', { text: q.source })]));
  if (q.history?.length) children.push(el('h4', { text: 'Review history' }), historyTimeline(q.history));
  return el('div', { class: 'detail' }, children);
}

function historyTimeline(history) {
  const labels = { submitted: 'Submitted for review', changes_requested: 'Changes requested', finalized: 'Finalized', comment: 'Comment', suggestion: 'Suggested an edit', suggestion_accepted: 'Suggestion accepted', suggestion_rejected: 'Suggestion rejected', imported: 'Imported from spreadsheet' };
  return el('ul', { class: 'timeline' }, history.slice().reverse().map((h) => el('li', { class: 'tl-item tl-' + h.action }, [
    el('div', { class: 'tl-head' }, [
      el('span', { class: 'tl-action', text: labels[h.action] || h.action }),
      el('span', { class: 'tl-meta', text: `${h.byName || ''} · ${fmtDate(h.at)} · review #${h.statusAt}` }),
    ]),
    h.comment ? el('div', { class: 'tl-comment', text: h.comment }) : null,
  ])));
}

function metaItem(k, v) { return el('div', { class: 'meta-item' }, [el('span', { class: 'meta-k', text: k }), el('span', { class: 'meta-v', text: String(v) })]); }
function metaItemNode(k, node) { return el('div', { class: 'meta-item' }, [el('span', { class: 'meta-k', text: k }), el('span', { class: 'meta-v' }, [node])]); }

// ── Suggested edits (Google-Docs / Overleaf style track-changes) ─────────────────
// Composer: a reviewer edits the question text; the change is shown as a live diff
// and saved as a pending suggestion the author can accept/reject.
function suggestionComposer(q) {
  const ta = el('textarea', { class: 'inp mono', rows: 4, value: q.questionText || '' });
  const diff = el('div', { class: 'diff-preview' });
  const status = el('div', { class: 'val-status' });
  const update = () => {
    diff.innerHTML = hasChanges(q.questionText, ta.value)
      ? diffToHtml(q.questionText, ta.value)
      : '<span class="muted">No changes yet — edit the text above to propose an edit.</span>';
    const v = validateLatex(ta.value, { allowEmpty: true });
    if (!ta.value.trim()) { status.className = 'val-status'; status.textContent = ''; }
    else if (v.ok) { status.className = 'val-status ok'; status.textContent = '✓ LaTeX valid'; }
    else { status.className = 'val-status bad'; status.textContent = '✕ ' + v.errors[0]; }
  };
  ta.addEventListener('input', debounce(update, 200));
  update();
  const send = el('button', {
    class: 'btn primary sm', text: 'Send suggestion ✎', onclick: async () => {
      if (!hasChanges(q.questionText, ta.value)) { toast('Make an edit before sending.', 'error'); return; }
      await S().addTextSuggestion(q.id, q.questionText, ta.value);
      toast('Suggestion sent to the author.', 'success');
    },
  });
  return el('div', { class: 'suggest-composer' }, [
    el('h4', { text: 'Suggest an edit to the question text' }),
    el('p', { class: 'muted sm', text: 'Edit below — your change is tracked (like Google Docs / Overleaf “suggesting”) and the author can accept or reject it. This does not change the question yet.' }),
    ta, status,
    el('div', { class: 'diff-label', text: 'Tracked change' }), diff,
    el('div', { class: 'row-end', style: 'margin-top:8px' }, [send]),
  ]);
}

// Pure render of the pending suggestions for a question (driven by a live watch).
function suggestionsSection(q, canResolve) {
  const pending = (q.suggestions || []).filter((s) => s.status === 'pending');
  const wrap = el('div', { class: 'suggest-list' }, [el('h4', { text: `Suggested edits${pending.length ? ` (${pending.length})` : ''}` })]);
  if (!pending.length) { wrap.appendChild(el('p', { class: 'muted sm', text: 'No pending suggestions.' })); return wrap; }
  for (const s of pending) {
    const mine = s.byUid === app.user.uid;
    const stale = (s.baseText || '') !== (q.questionText || '');
    const actions = el('div', { class: 'row-end gap', style: 'margin-top:8px' });
    if (canResolve) {
      actions.appendChild(el('button', { class: 'btn primary sm', text: '✓ Accept', onclick: async () => { await S().resolveSuggestion(q.id, s.id, 'accept'); toast('Suggestion applied.', 'success'); } }));
      actions.appendChild(el('button', { class: 'btn ghost sm', text: 'Reject', onclick: async () => { await S().resolveSuggestion(q.id, s.id, 'reject'); toast('Suggestion rejected.'); } }));
    }
    if (mine) actions.appendChild(el('button', { class: 'btn ghost sm', text: 'Withdraw', onclick: async () => { await S().resolveSuggestion(q.id, s.id, 'withdraw'); } }));
    wrap.appendChild(el('div', { class: 'suggest-item' }, [
      el('div', { class: 'suggest-meta' }, [el('strong', { text: s.byName || 'Reviewer' }), el('span', { class: 'tl-meta', text: ' · ' + fmtDate(s.at) }), stale ? el('span', { class: 'chip warn', text: 'based on older text' }) : null]),
      el('div', { class: 'diff-preview', html: diffToHtml(s.baseText || '', s.proposedText || '') }),
      actions,
    ]));
  }
  return wrap;
}

function pendingCount(q) { return (q.suggestions || []).filter((s) => s.status === 'pending').length; }

// The author's live view of one of their questions: detail + accept/reject suggestions.
function openMyQuestion(qInit) {
  const body = el('div', {});
  const render = (q) => {
    if (!q) { clear(body).appendChild(el('p', { text: 'This question was removed.' })); return; }
    clear(body);
    body.appendChild(questionDetail(q));
    body.appendChild(el('hr', {}));
    body.appendChild(suggestionsSection(q, q.writerUid === app.user.uid && q.state !== 'finalized'));
  };
  const stop = S().watchOne(qInit.id, render);
  modal(`Question #${qInit.humanId}`, body, { wide: true, onClose: stop });
}

// ── View: My Questions ────────────────────────────────────────────────────────────
function viewMine() {
  const host = clear(view());
  const listHost = el('div', { class: 'qlist' });
  host.appendChild(el('div', { class: 'page' }, [
    el('div', { class: 'page-head' }, [el('h1', { text: 'My questions' }), el('p', { class: 'muted', text: 'Your drafts, questions in review, returned questions, and finalized ones.' })]),
    listHost,
  ]));

  app.unsub = S().watchQuestions({ mine: true }, (rows) => {
    clear(listHost);
    if (!rows.length) { listHost.appendChild(emptyState('You haven’t written any questions yet.', 'Write your first one', () => navigate('write'))); return; }
    // Questions with something to resolve (changes requested or pending
    // suggestions) float to the top; otherwise newest-updated first.
    const sorted = rows.slice().sort((a, b) =>
      (needsAttention(b) ? 1 : 0) - (needsAttention(a) ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const q of sorted) listHost.appendChild(myCard(q));
  });
}

// A question of mine that needs the author to act: reviewer requested changes,
// or there are pending suggested edits to accept/reject.
function needsAttention(q) {
  return q.state === 'changes_requested' || pendingCount(q) > 0;
}

function myCard(q) {
  const attention = needsAttention(q);
  const pend = pendingCount(q);
  const actions = el('div', { class: 'card-actions' });

  if (q.state === 'changes_requested') {
    actions.appendChild(el('button', { class: 'btn primary sm', text: 'Revise & resubmit', onclick: () => openEditor(q) }));
  } else if (pend > 0) {
    actions.appendChild(el('button', { class: 'btn primary sm', text: 'Resolve suggestions', onclick: () => openMyQuestion(q) }));
    actions.appendChild(el('button', { class: 'btn ghost sm', text: 'Edit', onclick: () => openEditor(q) }));
  } else if (q.state === 'draft') {
    actions.appendChild(el('button', { class: 'btn primary sm', text: 'Edit', onclick: () => openEditor(q) }));
    actions.appendChild(el('button', { class: 'btn danger sm', text: 'Delete', onclick: async () => { if (await confirmDialog('Delete this draft?', { danger: true, confirmText: 'Delete' })) { await S().deleteQuestion(q.id); toast('Draft deleted.'); } } }));
  } else if (q.state === 'in_review') {
    actions.appendChild(el('button', { class: 'btn primary sm', text: 'Edit', onclick: () => openEditor(q) }));
  }
  actions.appendChild(el('button', { class: 'btn ghost sm', text: 'View', onclick: () => openMyQuestion(q) }));

  // "Changes to resolve" banner + the specific reasons.
  const reasons = [];
  if (q.state === 'changes_requested') reasons.push('changes requested');
  if (pend > 0) reasons.push(`${pend} suggested edit${pend > 1 ? 's' : ''} to review`);
  const banner = attention
    ? el('div', { class: 'attn-banner' }, [el('span', { class: 'attn-dot' }), el('strong', { text: 'Action needed' }), el('span', { text: ' — ' + reasons.join(' · ') })])
    : null;

  const lastChange = (q.history || []).filter((h) => h.action === 'changes_requested').slice(-1)[0];
  const feedback = (q.state === 'changes_requested' && lastChange?.comment)
    ? el('div', { class: 'feedback' }, [el('strong', { text: 'Reviewer feedback: ' }), el('span', { text: lastChange.comment })])
    : null;

  return el('div', { class: 'qcard' + (attention ? ' attention' : '') }, [
    el('div', { class: 'qcard-main' }, [
      banner,
      el('div', { class: 'qcard-top' }, [
        el('span', { class: 'qid', text: '#' + q.humanId }),
        stateBadge(q.state),
        el('span', { class: 'chip', text: `${q.tub} · ${q.type}` }),
        el('span', { class: 'chip', text: q.subject }),
        el('span', { class: 'chip subtle', text: q.subcat }),
        el('span', { class: 'chip subtle', text: 'Diff ' + (q.difficulty ?? '—') }),
        el('span', { class: 'chip subtle', text: 'Reviews ' + q.status }),
        pend ? el('span', { class: 'chip warn', text: `✎ ${pend} suggestion${pend > 1 ? 's' : ''}` }) : null,
      ]),
      el('div', { class: 'qcard-text', html: renderMixedToString(q.questionText).slice(0, 600) }),
      feedback,
    ]),
    actions,
  ]);
}

function emptyState(text, btnText, onClick) {
  return el('div', { class: 'empty' }, [el('p', { text }), btnText ? el('button', { class: 'btn primary', text: btnText, onclick: onClick }) : null]);
}

// ── View: Review Queue ────────────────────────────────────────────────────────────
function viewReview() {
  const host = clear(view());
  const filters = { subject: '', type: '', tub: '', difficulty: '', sort: 'status' };
  const controls = reviewControls(filters, () => apply());
  const listHost = el('div', { class: 'qlist' });

  host.appendChild(el('div', { class: 'page' }, [
    el('div', { class: 'page-head' }, [el('h1', { text: 'Review queue' }), el('p', { class: 'muted', text: 'Questions submitted by others. Add suggestions and send back, or approve to finalize.' })]),
    controls, listHost,
  ]));

  let all = [];
  const apply = () => {
    let rows = all.filter((q) => (!filters.subject || q.subject === filters.subject)
      && (!filters.type || q.type === filters.type)
      && (!filters.tub || q.tub === filters.tub)
      && (!filters.difficulty || String(q.difficulty) === filters.difficulty));
    rows.sort(sorters[filters.sort]);
    clear(listHost);
    if (!rows.length) { listHost.appendChild(emptyState('Nothing to review right now. 🎉')); return; }
    for (const q of rows) listHost.appendChild(reviewCard(q));
  };

  app.unsub = S().watchQuestions({ states: ['in_review'], excludeWriter: true }, (rows) => { all = rows; apply(); });
}

// How much review churn a question has accumulated: suggested edits + times it
// was sent back for changes.
function editLoad(q) {
  return (q.suggestions || []).length + (q.history || []).filter((h) => h.action === 'changes_requested').length;
}

const sorters = {
  status: (a, b) => (b.status - a.status) || (a.updatedAt - b.updatedAt),
  fewestEdits: (a, b) => editLoad(a) - editLoad(b) || (a.updatedAt - b.updatedAt),
  oldest: (a, b) => a.updatedAt - b.updatedAt,
  newest: (a, b) => b.updatedAt - a.updatedAt,
  difficulty: (a, b) => (a.difficulty || 0) - (b.difficulty || 0),
  subject: (a, b) => (a.subject || '').localeCompare(b.subject || ''),
};

function reviewControls(filters, onChange) {
  const mk = (items, key, ph, opts = {}) => {
    const s = el('select', { class: 'inp sm', onchange: () => { filters[key] = s.value; onChange(); } });
    fillSelect(s, items, { ...opts, placeholder: ph });
    return s;
  };
  const sortSel = el('select', { class: 'inp sm', onchange: () => { filters.sort = sortSel.value; onChange(); } });
  fillSelect(sortSel, [
    ['status', 'Most-reviewed first'], ['fewestEdits', 'Fewest edits/suggestions'], ['oldest', 'Oldest first'], ['newest', 'Newest first'], ['difficulty', 'Difficulty'], ['subject', 'Subject'],
  ], { value: (x) => x[0], label: (x) => x[1] });
  return el('div', { class: 'filters' }, [
    mk(T.SUBJECTS, 'subject', 'All subjects'),
    mk(T.TYPES, 'type', 'All types', { value: (x) => x.value, label: (x) => x.label }),
    mk(T.TUB, 'tub', 'TU & B', { value: (x) => x.value, label: (x) => x.label }),
    mk(T.DIFFICULTIES, 'difficulty', 'All difficulties', { value: (x) => x.value, label: (x) => x.label }),
    el('div', { class: 'spacer' }),
    el('span', { class: 'filter-label', text: 'Sort:' }), sortSel,
  ]);
}

function canFinalize() {
  return !CONFIG.restrictFinalizeToReviewers || ['reviewer', 'admin'].includes(app.user.role);
}

function reviewCard(q) {
  return el('div', { class: 'qcard' }, [
    el('div', { class: 'qcard-main' }, [
      el('div', { class: 'qcard-top' }, [
        el('span', { class: 'qid', text: '#' + q.humanId }),
        el('span', { class: 'chip warn', text: 'Review #' + q.status }),
        el('span', { class: 'chip', text: `${q.tub} · ${q.type}` }),
        el('span', { class: 'chip', text: q.subject }),
        el('span', { class: 'chip subtle', text: q.subcat }),
        el('span', { class: 'chip subtle', text: 'Diff ' + (q.difficulty ?? '—') }),
        el('span', { class: 'chip subtle', text: 'by ' + (q.writerInitials || q.writerName || '?') }),
        editLoad(q) ? el('span', { class: 'chip subtle', text: `${editLoad(q)} edit${editLoad(q) > 1 ? 's' : ''}/sugg.` }) : el('span', { class: 'chip subtle', text: 'untouched' }),
      ]),
      el('div', { class: 'qcard-text', html: renderMixedToString(q.questionText).slice(0, 600) }),
    ]),
    el('div', { class: 'card-actions' }, [el('button', { class: 'btn primary sm', text: 'Open review', onclick: () => openReview(q) })]),
  ]);
}

function openReview(q) {
  const comment = el('textarea', { class: 'inp', rows: 3, placeholder: 'Suggestions for the writer (required when requesting changes)…' });
  const msg = el('div', { class: 'form-msg' });

  // Live region: question detail + pending suggestions, refreshed in real time.
  const live = el('div', {});
  const renderLive = (cur) => {
    clear(live);
    if (!cur) { live.appendChild(el('p', { text: 'This question is no longer available.' })); return; }
    live.appendChild(questionDetail(cur));
    live.appendChild(el('hr', {}));
    live.appendChild(suggestionsSection(cur, false));
  };
  const stop = S().watchOne(q.id, renderLive);

  const body = el('div', {}, [
    live,
    el('hr', {}),
    suggestionComposer(q),
    el('hr', {}),
    el('h4', { text: 'Your review' }),
    comment, msg,
    el('div', { class: 'row-end gap', style: 'margin-top:14px' }, [
      el('button', {
        class: 'btn ghost sm', text: 'Add comment only', onclick: async () => {
          if (!comment.value.trim()) { msg.className = 'form-msg error'; msg.textContent = 'Write a comment first.'; return; }
          await S().addComment(q.id, comment.value.trim()); toast('Comment added.'); m.close();
        },
      }),
      el('button', {
        class: 'btn warn', text: 'Request changes ↩', onclick: async () => {
          if (!comment.value.trim()) { msg.className = 'form-msg error'; msg.textContent = 'Please add suggestions before sending back.'; return; }
          await S().requestChanges(q.id, comment.value.trim());
          toast('Sent back to the writer.', 'success'); m.close();
        },
      }),
      canFinalize() ? el('button', {
        class: 'btn primary', text: 'Approve & finalize ★', onclick: async () => {
          if (!(await confirmDialog('Approve this question and move it to the finalized database?', { confirmText: 'Finalize' }))) return;
          await S().finalize(q.id, comment.value.trim());
          toast('Finalized! 🎉', 'success'); m.close();
        },
      }) : el('span', { class: 'muted sm', text: 'Only reviewers/admins can finalize.' }),
    ]),
  ]);
  const m = modal(`Reviewing question #${q.humanId}`, body, { wide: true, onClose: stop });
}

// ── View: Finalized ────────────────────────────────────────────────────────────────
function viewFinalized() {
  const host = clear(view());
  const filters = { subject: '', subcat: '', type: '', tub: '', difficulty: '', writer: '', q: '', sort: 'newest' };

  const subjectSel = el('select', { class: 'inp sm' });
  fillSelect(subjectSel, T.SUBJECTS, { placeholder: 'All subjects' });
  const subcatSel = el('select', { class: 'inp sm' });
  fillSelect(subcatSel, [], { placeholder: 'All subcategories' });
  const typeSel = el('select', { class: 'inp sm' });
  fillSelect(typeSel, T.TYPES, { value: (x) => x.value, label: (x) => x.label, placeholder: 'All types' });
  const tubSel = el('select', { class: 'inp sm' });
  fillSelect(tubSel, T.TUB, { value: (x) => x.value, label: (x) => x.label, placeholder: 'TU & B' });
  const diffSel = el('select', { class: 'inp sm' });
  fillSelect(diffSel, T.DIFFICULTIES, { value: (x) => x.value, label: (x) => x.label, placeholder: 'All difficulties' });
  const writerInp = el('input', { class: 'inp sm', placeholder: 'Writer initials' });
  const search = el('input', { class: 'inp sm grow', placeholder: 'Search question text…' });
  const sortSel = el('select', { class: 'inp sm' });
  fillSelect(sortSel, [['newest', 'Newest'], ['oldest', 'Oldest'], ['id', 'ID'], ['difficulty', 'Difficulty'], ['subject', 'Subject']], { value: (x) => x[0], label: (x) => x[1] });

  subjectSel.addEventListener('change', () => {
    filters.subject = subjectSel.value; filters.subcat = '';
    fillSelect(subcatSel, T.subcatsFor(subjectSel.value), { placeholder: 'All subcategories' });
    apply();
  });
  const bind = (node, key, ev = 'change') => node.addEventListener(ev, () => { filters[key] = node.value; apply(); });
  bind(subcatSel, 'subcat'); bind(typeSel, 'type'); bind(tubSel, 'tub'); bind(diffSel, 'difficulty');
  bind(writerInp, 'writer', 'input'); bind(search, 'q', 'input'); bind(sortSel, 'sort');

  const tableHost = el('div', { class: 'table-host' });
  const countLabel = el('span', { class: 'muted sm' });

  const exportCsv = el('button', { class: 'btn ghost sm', text: '⬇ CSV', onclick: () => downloadCsv(currentRows) });
  const exportJson = el('button', { class: 'btn ghost sm', text: '⬇ JSON', onclick: () => downloadJson(currentRows) });

  host.appendChild(el('div', { class: 'page' }, [
    el('div', { class: 'page-head' }, [el('h1', { text: 'Finalized database' }), el('p', { class: 'muted', text: 'Approved questions. Filter, sort, search, and export.' })]),
    el('div', { class: 'filters wrap' }, [subjectSel, subcatSel, typeSel, tubSel, diffSel, writerInp, search, el('span', { class: 'filter-label', text: 'Sort:' }), sortSel, el('div', { class: 'spacer' }), exportCsv, exportJson]),
    countLabel,
    tableHost,
  ]));

  let all = []; let currentRows = [];
  const apply = () => {
    currentRows = all.filter((q) => (!filters.subject || q.subject === filters.subject)
      && (!filters.subcat || q.subcat === filters.subcat)
      && (!filters.type || q.type === filters.type)
      && (!filters.tub || q.tub === filters.tub)
      && (!filters.difficulty || String(q.difficulty) === filters.difficulty)
      && (!filters.writer || (q.writerInitials || '').toLowerCase().includes(filters.writer.toLowerCase()))
      && (!filters.q || (q.questionText || '').toLowerCase().includes(filters.q.toLowerCase()) || (q.answerLine || '').toLowerCase().includes(filters.q.toLowerCase())));
    const fsort = { newest: (a, b) => (b.finalizedAt || 0) - (a.finalizedAt || 0), oldest: (a, b) => (a.finalizedAt || 0) - (b.finalizedAt || 0), id: (a, b) => a.humanId - b.humanId, difficulty: (a, b) => (a.difficulty || 0) - (b.difficulty || 0), subject: (a, b) => (a.subject || '').localeCompare(b.subject || '') };
    currentRows.sort(fsort[filters.sort]);
    countLabel.textContent = `${currentRows.length} question${currentRows.length === 1 ? '' : 's'}`;
    renderTable(tableHost, currentRows);
  };

  app.unsub = S().watchQuestions({ finalized: true }, (rows) => { all = rows; apply(); });
}

function renderTable(host, rows) {
  clear(host);
  if (!rows.length) { host.appendChild(emptyState('No finalized questions match these filters.')); return; }
  const head = el('tr', {}, ['ID', 'TU/B', 'Subject', 'Subcat', 'Type', 'Diff', 'Reviews', 'Writer', 'Question', ''].map((h) => el('th', { text: h })));
  const body = el('tbody', {}, rows.map((q) => {
    const text = (q.questionText || '').replace(/\$[^$]*\$/g, '∎').replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1').slice(0, 90);
    return el('tr', {}, [
      el('td', { text: '#' + q.humanId }),
      el('td', { text: q.tub }),
      el('td', { text: q.subject }),
      el('td', { class: 'nowrap-sm', text: q.subcat }),
      el('td', { text: q.type }),
      el('td', { text: q.difficulty ?? '—' }),
      el('td', { text: q.status }),
      el('td', { text: q.writerInitials || '—' }),
      el('td', { class: 'q-cell', text: text + (q.questionText && q.questionText.length > 90 ? '…' : '') }),
      el('td', {}, [el('button', { class: 'btn ghost xs', text: 'View', onclick: () => modal(`Question #${q.humanId}`, questionDetail(q), { wide: true }) })]),
    ]);
  }));
  host.appendChild(el('table', { class: 'qtable' }, [el('thead', {}, [head]), body]));
}

// ── Export helpers ───────────────────────────────────────────────────────────────
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(rows) {
  const headers = ['TU/B', 'Subject', 'Type', 'Subcat', 'Question Text', 'IF SA - Answer Line', 'W', 'X', 'Y', 'Z', 'IF MC - Answer', 'Difficulty', 'Status', 'ID', 'Source', 'Writer Initials'];
  const lines = [headers.join(',')];
  for (const q of rows) {
    lines.push([q.tub, q.subject, q.type, q.subcat, q.questionText, q.type === 'SA' ? q.answerLine : '', q.choices?.W, q.choices?.X, q.choices?.Y, q.choices?.Z, q.type === 'MC' ? q.mcAnswer : '', q.difficulty, q.status, q.humanId, q.source, q.writerInitials].map(csvEscape).join(','));
  }
  triggerDownload(new Blob([lines.join('\n')], { type: 'text/csv' }), 'finalized-questions.csv');
}
function downloadJson(rows) {
  triggerDownload(new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' }), 'finalized-questions.json');
}
function triggerDownload(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}

// ── View: Admin (sub-tabs: Users / Import / Backups) ─────────────────────────────
function viewAdmin() {
  const host = clear(view());
  let tab = 'users';
  const content = el('div', {});
  const tabBtn = (key, label) => el('button', { class: 'subtab' + (tab === key ? ' active' : ''), text: label, onclick: () => { tab = key; draw(); } });
  const tabs = el('div', { class: 'subtabs' });
  const draw = () => {
    cleanupSub(); // tear down a previous sub-tab's listeners (e.g. backups)
    clear(tabs); tabs.append(tabBtn('users', 'Users & roles'), tabBtn('import', 'Import spreadsheet'), tabBtn('backups', 'Backups'));
    clear(content);
    if (tab === 'users') adminUsers(content);
    else if (tab === 'import') adminImport(content);
    else adminBackups(content);
  };
  host.appendChild(el('div', { class: 'page' }, [
    el('div', { class: 'page-head' }, [el('h1', { text: 'Admin' }), el('p', { class: 'muted', text: 'Manage users, bulk-import questions, and manage backups.' })]),
    tabs, content,
  ]));
  draw();
}

function adminUsers(host) {
  clear(host);
  const wrap = el('div', {});
  host.appendChild(wrap);

  const reload = () => { invalidatePending(); renderHeader(); load(); };

  const approveRow = (u, buttons) => el('div', { class: 'approve-row' }, [
    el('div', {}, [el('strong', { text: u.email }), el('span', { class: 'muted sm', text: ` · ${u.displayName || '—'}${u.initials ? ' (' + u.initials + ')' : ''}` })]),
    el('div', { class: 'row-end gap' }, buttons),
  ]);

  const load = () => {
    S().listUsers().then((users) => {
      clear(wrap);
      const pending = users.filter((u) => u.role === 'pending');
      const members = users.filter((u) => isApprovedRole(u.role));
      const declined = users.filter((u) => u.role === 'rejected');

      // — Pending approvals —
      const pendHost = el('div', { class: 'admin-section' });
      pendHost.appendChild(el('h3', {}, ['Pending approval ', pending.length ? el('span', { class: 'nav-badge inline', text: String(pending.length) }) : el('span', { class: 'muted', text: '(none)' })]));
      for (const u of pending) {
        pendHost.appendChild(approveRow(u, [
          el('button', { class: 'btn primary sm', text: '✓ Approve', onclick: async () => { await S().setUserRole(u.uid, 'writer'); toast(`${u.email} approved.`, 'success'); reload(); } }),
          el('button', { class: 'btn ghost sm', text: 'Decline', onclick: async () => { await S().setUserRole(u.uid, 'rejected'); toast(`${u.email} declined.`); reload(); } }),
        ]));
      }
      wrap.appendChild(pendHost);

      // — Members —
      const memHost = el('div', { class: 'admin-section' });
      memHost.appendChild(el('h3', { text: `Members (${members.length})` }));
      const body = el('tbody', {}, members.map((u) => {
        const isSelf = u.uid === app.user.uid;
        const sel = el('select', { class: 'inp sm', disabled: isSelf });
        fillSelect(sel, [['writer', 'Writer'], ['reviewer', 'Reviewer'], ['admin', 'Admin']], { value: (x) => x[0], label: (x) => x[1], selected: u.role });
        sel.addEventListener('change', async () => { await S().setUserRole(u.uid, sel.value); toast(`${u.email} is now ${sel.value}.`, 'success'); });
        const remove = el('button', { class: 'btn ghost xs', text: 'Remove access', disabled: isSelf, onclick: async () => { if (await confirmDialog(`Remove ${u.email}'s access?`, { danger: true, confirmText: 'Remove' })) { await S().setUserRole(u.uid, 'rejected'); toast('Access removed.'); reload(); } } });
        return el('tr', {}, [el('td', { text: u.email }), el('td', { text: u.displayName || '—' }), el('td', { text: u.initials || '—' }), el('td', {}, [sel]), el('td', {}, [remove])]);
      }));
      memHost.appendChild(el('div', { class: 'table-host' }, [el('table', { class: 'qtable' }, [el('thead', {}, [el('tr', {}, ['Email', 'Name', 'Initials', 'Role', ''].map((h) => el('th', { text: h })))]), body])]));
      wrap.appendChild(memHost);

      // — Declined —
      if (declined.length) {
        const decHost = el('div', { class: 'admin-section' });
        decHost.appendChild(el('h3', { text: `Declined (${declined.length})` }));
        for (const u of declined) {
          decHost.appendChild(approveRow(u, [el('button', { class: 'btn ghost sm', text: 'Restore', onclick: async () => { await S().setUserRole(u.uid, 'writer'); toast(`${u.email} restored.`, 'success'); reload(); } })]));
        }
        wrap.appendChild(decHost);
      }
    }).catch((e) => {
      clear(wrap);
      wrap.appendChild(el('div', { class: 'err-box' }, [
        el('strong', { text: 'Couldn’t load users. ' }),
        el('span', { text: explainError(e) }),
      ]));
    });
  };
  load();
}

function adminImport(host) {
  clear(host);
  const fileInp = el('input', { type: 'file', accept: '.csv,text/csv', class: 'inp' });
  const assignSel = el('select', { class: 'inp sm' });
  const skipBad = el('input', { type: 'checkbox', checked: true });
  const info = el('div', { class: 'import-info' });
  const previewHost = el('div', { class: 'table-host', style: 'margin-top:12px' });
  const importBtn = el('button', { class: 'btn primary', text: 'Import', disabled: true });
  let parsed = { questions: [], missing: ['(choose a file)'] };
  let users = [];

  const pickDefault = () => users.find((u) => u.email?.toLowerCase() === (CONFIG.mainAccountEmail || '').toLowerCase())
    || users.find((u) => u.uid === app.user.uid) || users[0];

  S().listUsers().then((us) => {
    users = us;
    fillSelect(assignSel, users, { value: (u) => u.uid, label: (u) => `${u.email}${u.initials ? ' (' + u.initials + ')' : ''}`, selected: pickDefault()?.uid });
  });

  const validityOf = (q) => validateQuestion(q);

  const renderPreview = () => {
    clear(info); clear(previewHost);
    if (parsed.missing && parsed.missing.length) {
      importBtn.disabled = true;
      info.appendChild(el('div', { class: 'err-box' }, [el('strong', { text: 'Can’t read that file. ' }), el('span', { text: 'Missing required column(s): ' + parsed.missing.join(', ') + '. Use the same headers as the Master Sheet.' })]));
      return;
    }
    const qs = parsed.questions;
    if (!qs.length) { importBtn.disabled = true; info.textContent = 'No question rows found.'; return; }
    const bad = qs.filter((q) => !validityOf(q).ok).length;
    importBtn.disabled = false;
    info.appendChild(el('p', {}, [
      el('strong', { text: `${qs.length} question${qs.length === 1 ? '' : 's'} ready to import. ` }),
      el('span', { class: bad ? 'warn-text' : 'muted', text: bad ? `${bad} have LaTeX issues.` : 'All pass LaTeX validation.' }),
    ]));
    const head = el('tr', {}, ['', 'ID', 'TU/B', 'Subject', 'Type', 'Diff', 'Question', 'LaTeX'].map((h) => el('th', { text: h })));
    const rows = qs.slice(0, 25).map((q, i) => {
      const v = validityOf(q);
      return el('tr', {}, [
        el('td', { text: String(i + 1) }),
        el('td', { text: q.csvId != null ? '#' + q.csvId : 'new' }),
        el('td', { text: q.tub || '—' }),
        el('td', { text: q.subject || '—' }),
        el('td', { text: q.type || '—' }),
        el('td', { text: q.difficulty ?? '—' }),
        el('td', { class: 'q-cell', text: (q.questionText || '').replace(/\s+/g, ' ').slice(0, 80) }),
        el('td', {}, [v.ok ? el('span', { class: 'ok-text', text: '✓' }) : el('span', { class: 'bad-text', text: '✕', title: v.errors[0] })]),
      ]);
    });
    previewHost.appendChild(el('table', { class: 'qtable' }, [el('thead', {}, [head]), el('tbody', {}, rows)]));
    if (qs.length > 25) previewHost.appendChild(el('p', { class: 'muted sm', text: `…and ${qs.length - 25} more.` }));
  };

  fileInp.addEventListener('change', async () => {
    const f = fileInp.files[0];
    if (!f) return;
    try { parsed = csvToQuestions(await f.text()); }
    catch (e) { parsed = { questions: [], missing: ['(could not parse file: ' + e.message + ')'] }; }
    renderPreview();
  });

  importBtn.addEventListener('click', async () => {
    let list = parsed.questions;
    if (skipBad.checked) list = list.filter((q) => validityOf(q).ok);
    if (!list.length) { toast('Nothing to import (all rows were skipped).', 'error'); return; }
    const owner = users.find((u) => u.uid === assignSel.value) || pickDefault();
    if (!owner) { toast('Pick an account to assign to.', 'error'); return; }
    if (!(await confirmDialog(`Import ${list.length} questions and assign them to ${owner.email}? They will enter the review queue.`, { confirmText: 'Import' }))) return;
    importBtn.disabled = true;
    try {
      const n = await S().bulkImport(list, owner);
      toast(`Imported ${n} questions into the review queue.`, 'success');
      fileInp.value = ''; parsed = { questions: [], missing: ['(choose a file)'] }; renderPreview();
    } catch (e) { toast('Import failed: ' + e.message, 'error'); }
    importBtn.disabled = false;
  });

  host.appendChild(el('div', { class: 'card' }, [
    el('p', { class: 'muted', text: 'Upload a spreadsheet (CSV) using the same columns as the Master Sheet (TU/B, Subject, Type, Subcat, Question Text, IF SA - Answer Line, W, X, Y, Z, IF MC - Answer, Difficulty, Status, ID, Source, Writer Initials). Imported questions enter at “in review” and are assigned to the account below.' }),
    el('div', { class: 'grid-3' }, [
      labeled('CSV file', fileInp),
      labeled('Assign all to (“main” account)', assignSel),
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'Options' }), el('label', { class: 'check-row' }, [skipBad, el('span', { text: 'Skip rows with LaTeX errors' })])]),
    ]),
    info, previewHost,
    el('div', { class: 'row-end', style: 'margin-top:14px' }, [importBtn]),
  ]));
}

function adminBackups(host) {
  clear(host);
  const listHost = el('div', { class: 'table-host' });
  const refresh = () => {
    const snaps = Backup.listSnapshots();
    clear(listHost);
    if (!snaps.length) { listHost.appendChild(emptyState('No backups yet. One is taken automatically every few minutes.')); return; }
    const body = el('tbody', {}, snaps.map((s) => el('tr', {}, [
      el('td', { text: fmtDate(s.at) }),
      el('td', { text: s.count + ' questions' }),
      el('td', {}, [
        el('button', { class: 'btn ghost xs', text: '⬇ Download', onclick: async () => { const data = await Backup.getSnapshotData(s.at); if (data) Backup.downloadJson(data, `sbq-backup-${new Date(s.at).toISOString().slice(0, 19)}.json`); } }),
        el('button', { class: 'btn ghost xs', text: '↺ Restore', style: 'margin-left:6px', onclick: async () => {
          if (!(await confirmDialog(`Restore ${s.count} questions from ${fmtDate(s.at)}? Existing questions with the same ID will be overwritten.`, { confirmText: 'Restore', danger: true }))) return;
          const data = await Backup.getSnapshotData(s.at);
          if (data) { await S().bulkUpsert(data); toast('Backup restored.', 'success'); }
        } }),
      ]),
    ])));
    listHost.appendChild(el('table', { class: 'qtable' }, [el('thead', {}, [el('tr', {}, ['When', 'Size', 'Actions'].map((h) => el('th', { text: h })))]), body]));
  };

  const onBackup = () => refresh();
  document.addEventListener('sbq-backup', onBackup);
  // stop listening when leaving the view
  app.unsub = () => document.removeEventListener('sbq-backup', onBackup);

  host.appendChild(el('div', { class: 'card' }, [
    el('p', { class: 'muted', text: `Questions are automatically snapshotted to this browser every ${CONFIG.backup.intervalMinutes} minutes (keeping the last ${CONFIG.backup.keep}). Download a snapshot to keep an off-device copy, or restore one if something goes wrong.` }),
    el('div', { class: 'row-end gap', style: 'margin-bottom:14px' }, [
      el('button', { class: 'btn ghost', text: '⬇ Download all current', onclick: () => Backup.downloadJson(app.allQuestions, `sbq-questions-${new Date().toISOString().slice(0, 10)}.json`) }),
      el('button', { class: 'btn primary', text: '＋ Back up now', onclick: async () => { await Backup.snapshotNow({ force: true }); refresh(); toast('Backup created.', 'success'); } }),
    ]),
    listHost,
  ]));
  refresh();
}
