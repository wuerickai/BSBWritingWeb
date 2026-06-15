// ────────────────────────────────────────────────────────────────────────────
//  LOCAL backend — browser localStorage. Zero setup; for demos / trying it out.
//  NOT secure and NOT shared across devices. Passwords are hashed (SHA-256) but
//  this is a client-side toy; use the firebase backend for anything real.
//  Exposes the same async API as store/firebase.js.
// ────────────────────────────────────────────────────────────────────────────

import { CONFIG } from '../config.js';

const K_USERS = 'sbq_users';
const K_QUESTIONS = 'sbq_questions';
const K_SESSION = 'sbq_session';
const K_COUNTER = 'sbq_counter';

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let _user = null;                 // cached current user (full shape) or null
const authListeners = new Set();
const dataListeners = new Set();

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 't' + Date.now() + Math.random().toString(16).slice(2));
const now = () => Date.now();

function emitData() { dataListeners.forEach((fn) => fn()); }
function emitAuth() { authListeners.forEach((fn) => fn(_user)); }

function userShape(rec) {
  if (!rec) return null;
  return {
    uid: rec.uid,
    email: rec.email,
    emailVerified: !!rec.emailVerified,
    displayName: rec.displayName || '',
    initials: rec.initials || '',
    role: rec.role || 'writer',
  };
}

function loadSession() {
  const uid = read(K_SESSION, null);
  if (!uid) { _user = null; return; }
  const rec = read(K_USERS, []).find((u) => u.uid === uid);
  _user = userShape(rec);
}

export async function init() {
  loadSession();
  // cross-tab updates
  window.addEventListener('storage', (e) => {
    if (e.key === K_QUESTIONS || e.key === K_USERS) emitData();
    if (e.key === K_SESSION) { loadSession(); emitAuth(); }
  });
}

// ── Auth ─────────────────────────────────────────────────────────────────────
export function onAuthChange(cb) { authListeners.add(cb); cb(_user); return () => authListeners.delete(cb); }
export function getCurrentUser() { return _user; }

export async function signUp({ email, password, displayName, initials }) {
  email = String(email).trim().toLowerCase();
  if (!email || !password) throw new Error('Email and password are required.');
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');
  const users = read(K_USERS, []);
  if (users.some((u) => u.email === email)) throw new Error('An account with that email already exists.');
  const salt = newId();
  const rec = {
    uid: newId(),
    email,
    salt,
    hash: await sha256(salt + ':' + password),
    displayName: displayName || '',
    initials: (initials || '').toUpperCase(),
    // First account ever (or a configured admin email) bootstraps as admin so the
    // approval queue has someone to manage it; everyone else waits for approval.
    role: (users.length === 0 || CONFIG.adminEmails.map((e) => e.toLowerCase()).includes(email)) ? 'admin' : 'pending',
    emailVerified: false,
    createdAt: now(),
  };
  users.push(rec);
  write(K_USERS, users);
  write(K_SESSION, rec.uid);
  _user = userShape(rec);
  emitAuth();
  return _user;
}

export async function signIn({ email, password }) {
  email = String(email).trim().toLowerCase();
  const users = read(K_USERS, []);
  const rec = users.find((u) => u.email === email);
  if (!rec) throw new Error('No account found with that email.');
  const h = await sha256(rec.salt + ':' + password);
  if (h !== rec.hash) throw new Error('Incorrect password.');
  write(K_SESSION, rec.uid);
  _user = userShape(rec);
  emitAuth();
  return _user;
}

export async function signOutUser() {
  localStorage.removeItem(K_SESSION);
  _user = null;
  emitAuth();
}

export async function sendVerification() {
  // No real email in local mode — see devVerify() for the simulated click.
  return { simulated: true };
}

export async function resetPassword(email) {
  // Demo only: report success if the account exists.
  const exists = read(K_USERS, []).some((u) => u.email === String(email).trim().toLowerCase());
  if (!exists) throw new Error('No account found with that email.');
  return { simulated: true };
}

export async function reloadUser() { loadSession(); emitAuth(); return _user; }

// Local-only helper the UI uses to simulate clicking the email-verification link.
export async function devVerify() {
  if (!_user) return;
  const users = read(K_USERS, []);
  const rec = users.find((u) => u.uid === _user.uid);
  if (rec) { rec.emailVerified = true; write(K_USERS, users); _user = userShape(rec); emitAuth(); }
}

// ── Users (admin) ─────────────────────────────────────────────────────────────
export async function listUsers() {
  return read(K_USERS, []).map(userShape).sort((a, b) => a.email.localeCompare(b.email));
}

export async function setUserRole(uid, role) {
  const users = read(K_USERS, []);
  const rec = users.find((u) => u.uid === uid);
  if (!rec) throw new Error('User not found.');
  rec.role = role;
  write(K_USERS, users);
  if (_user && _user.uid === uid) { _user = userShape(rec); emitAuth(); }
  emitData();
}

// ── Questions ─────────────────────────────────────────────────────────────────
function nextHumanId() {
  const c = read(K_COUNTER, 0) + 1;
  write(K_COUNTER, c);
  return c;
}

function allQuestions() { return read(K_QUESTIONS, []); }
function saveQuestions(arr) { write(K_QUESTIONS, arr); emitData(); }

function requireUser() { if (!_user) throw new Error('Not signed in.'); return _user; }

export async function createQuestion(data) {
  const u = requireUser();
  const q = {
    id: newId(),
    humanId: nextHumanId(),
    tub: data.tub || '',
    subject: data.subject || '',
    type: data.type || '',
    subcat: data.subcat || '',
    questionText: data.questionText || '',
    answerLine: data.answerLine || '',
    choices: data.choices || { W: '', X: '', Y: '', Z: '' },
    mcAnswer: data.mcAnswer || '',
    difficulty: data.difficulty || null,
    source: data.source || '',
    writerUid: u.uid,
    writerName: data.writerName || u.displayName || u.email,
    writerInitials: (data.writerInitials || u.initials || '').toUpperCase(),
    status: 0,
    state: 'draft',
    history: [],
    suggestions: [],
    createdAt: now(),
    updatedAt: now(),
    finalizedAt: null,
  };
  const arr = allQuestions();
  arr.push(q);
  saveQuestions(arr);
  return q;
}

function mutate(id, fn) {
  const arr = allQuestions();
  const q = arr.find((x) => x.id === id);
  if (!q) throw new Error('Question not found.');
  fn(q);
  q.updatedAt = now();
  saveQuestions(arr);
  return q;
}

export async function updateDraft(id, patch) {
  return mutate(id, (q) => {
    if (q.state === 'finalized') throw new Error('Finalized questions can’t be edited.');
    Object.assign(q, patch);
  });
}

export async function deleteQuestion(id) {
  const arr = allQuestions().filter((x) => x.id !== id);
  saveQuestions(arr);
}

export async function submitForReview(id, patch = null) {
  const u = requireUser();
  return mutate(id, (q) => {
    if (patch) Object.assign(q, patch);
    q.status = (q.status || 0) + 1;
    q.state = 'in_review';
    q.history.push({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'submitted', comment: '', statusAt: q.status });
  });
}

export async function requestChanges(id, comment) {
  const u = requireUser();
  return mutate(id, (q) => {
    q.state = 'changes_requested';
    q.history.push({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'changes_requested', comment: comment || '', statusAt: q.status });
  });
}

export async function finalize(id, comment) {
  const u = requireUser();
  return mutate(id, (q) => {
    q.state = 'finalized';
    q.finalizedAt = now();
    q.history.push({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'finalized', comment: comment || '', statusAt: q.status });
  });
}

export async function addComment(id, comment) {
  const u = requireUser();
  return mutate(id, (q) => {
    q.history.push({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'comment', comment: comment || '', statusAt: q.status });
  });
}

// ── Suggested edits (track-changes on question text) ─────────────────────────
export async function addTextSuggestion(id, baseText, proposedText) {
  const u = requireUser();
  return mutate(id, (q) => {
    q.suggestions = q.suggestions || [];
    q.suggestions.push({
      id: newId(), byUid: u.uid, byName: u.displayName || u.email, at: now(),
      status: 'pending', baseText: baseText ?? q.questionText, proposedText,
    });
    q.history.push({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'suggestion', comment: '', statusAt: q.status });
  });
}

export async function resolveSuggestion(id, sugId, action) {
  const u = requireUser();
  return mutate(id, (q) => {
    const s = (q.suggestions || []).find((x) => x.id === sugId);
    if (!s) throw new Error('Suggestion not found.');
    if (action === 'accept') {
      q.questionText = s.proposedText;
      s.status = 'accepted';
      q.history.push({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'suggestion_accepted', comment: '', statusAt: q.status });
    } else if (action === 'reject') {
      s.status = 'rejected';
      q.history.push({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'suggestion_rejected', comment: '', statusAt: q.status });
    } else if (action === 'withdraw') {
      s.status = 'withdrawn';
    }
    s.resolvedBy = u.uid; s.resolvedAt = now();
  });
}

// ── Bulk import (CSV) → questions owned by `owner`, entering review ───────────
export async function bulkImport(questions, owner) {
  requireUser();
  const arr = allQuestions();
  const used = new Set(arr.map((q) => q.humanId));
  let counter = read(K_COUNTER, 0);
  const allocId = (preferred) => {
    if (preferred != null && !used.has(preferred)) { used.add(preferred); counter = Math.max(counter, preferred); return preferred; }
    do { counter += 1; } while (used.has(counter));
    used.add(counter); return counter;
  };
  const created = [];
  for (const data of questions) {
    const q = {
      id: newId(),
      humanId: allocId(data.csvId),
      tub: data.tub || '', subject: data.subject || '', type: data.type || '', subcat: data.subcat || '',
      questionText: data.questionText || '', answerLine: data.answerLine || '',
      choices: data.choices || { W: '', X: '', Y: '', Z: '' }, mcAnswer: data.mcAnswer || '',
      difficulty: data.difficulty ?? null, source: data.source || '',
      writerUid: owner.uid, writerName: owner.displayName || owner.email,
      writerInitials: (data.writerInitials || owner.initials || '').toUpperCase(),
      status: 1, state: 'in_review',
      history: [{ at: now(), byUid: owner.uid, byName: owner.displayName || owner.email, action: 'imported', comment: 'Imported from spreadsheet', statusAt: 1 }],
      suggestions: [],
      createdAt: now(), updatedAt: now(), finalizedAt: null, imported: true,
    };
    arr.push(q); created.push(q);
  }
  write(K_COUNTER, counter);
  saveQuestions(arr);
  return created.length;
}

// Restore / merge a set of question records (used by backup restore).
export async function bulkUpsert(questions) {
  const arr = allQuestions();
  const byId = new Map(arr.map((q) => [q.id, q]));
  for (const q of questions) byId.set(q.id, q);
  const merged = [...byId.values()];
  write(K_COUNTER, Math.max(read(K_COUNTER, 0), merged.reduce((m, q) => Math.max(m, q.humanId || 0), 0)));
  saveQuestions(merged);
  return merged.length;
}

// Live subscription to a single question (for open suggestion panels).
export function watchOne(id, cb) {
  const run = () => cb(allQuestions().find((q) => q.id === id) || null);
  dataListeners.add(run);
  run();
  return () => dataListeners.delete(run);
}

// Filtered live subscription. filter keys: mine, excludeWriter, finalized, states[]
export function watchQuestions(filter, cb) {
  const run = () => {
    const u = _user;
    let arr = allQuestions();
    if (filter.mine && u) arr = arr.filter((q) => q.writerUid === u.uid);
    if (filter.excludeWriter && u && CONFIG.hideOwnQuestionsFromReviewer) arr = arr.filter((q) => q.writerUid !== u.uid);
    if (filter.finalized) arr = arr.filter((q) => q.state === 'finalized');
    if (filter.states) arr = arr.filter((q) => filter.states.includes(q.state));
    arr = arr.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    cb(arr);
  };
  dataListeners.add(run);
  run();
  return () => dataListeners.delete(run);
}

export const meta = { kind: 'local' };
