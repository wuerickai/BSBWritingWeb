// ────────────────────────────────────────────────────────────────────────────
//  FIREBASE backend — real accounts (email verification + password reset) and a
//  shared Firestore database. Loaded only when CONFIG.backend === 'firebase'.
//  Mirrors the API of store/local.js.
//
//  Firestore layout:
//    users/{uid}      → { email, displayName, initials, role, createdAt }
//    questions/{id}   → full question document (see createQuestion)
//    meta/counters    → { humanId }   (sequential human-friendly IDs)
// ────────────────────────────────────────────────────────────────────────────

import { CONFIG } from '../config.js';

const V = '10.12.2';
let app, auth, db, A, F;        // SDK namespaces
let _user = null;               // cached current user (full shape)
let _profileCache = {};
const authListeners = new Set();

const now = () => Date.now();

// Emails in CONFIG.adminEmails are treated as admins regardless of their stored
// profile role (the matching allowlist also lives in firestore.rules → keep them
// in sync). This lets the first admins bootstrap themselves just by signing up.
function effectiveRole(email, profileRole) {
  const isBootstrap = CONFIG.adminEmails.map((e) => e.toLowerCase()).includes((email || '').toLowerCase());
  return isBootstrap ? 'admin' : (profileRole || 'pending');
}

function emitAuth() { authListeners.forEach((fn) => fn(_user)); }

export async function init() {
  const appMod = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  A = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
  F = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
  app = appMod.initializeApp(CONFIG.firebase);
  auth = A.getAuth(app);
  db = F.getFirestore(app);

  A.onAuthStateChanged(auth, async (fbUser) => {
    if (!fbUser) { _user = null; emitAuth(); return; }
    const profile = await ensureProfile(fbUser);
    _user = {
      uid: fbUser.uid,
      email: fbUser.email,
      emailVerified: fbUser.emailVerified,
      displayName: profile.displayName || '',
      initials: profile.initials || '',
      role: effectiveRole(fbUser.email, profile.role),
    };
    emitAuth();
  });
}

async function ensureProfile(fbUser) {
  const ref = F.doc(db, 'users', fbUser.uid);
  const snap = await F.getDoc(ref);
  if (snap.exists()) { _profileCache[fbUser.uid] = snap.data(); return snap.data(); }
  // New profiles always start as 'pending' — an admin must approve them. (The
  // very first admin is bootstrapped once in the Firebase console; see README.)
  const profile = {
    email: fbUser.email,
    displayName: fbUser.displayName || '',
    initials: '',
    role: 'pending',
    createdAt: now(),
  };
  await F.setDoc(ref, profile);
  _profileCache[fbUser.uid] = profile;
  return profile;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
export function onAuthChange(cb) { authListeners.add(cb); cb(_user); return () => authListeners.delete(cb); }
export function getCurrentUser() { return _user; }

export async function signUp({ email, password, displayName, initials }) {
  email = String(email).trim().toLowerCase();
  const cred = await A.createUserWithEmailAndPassword(auth, email, password);
  await F.setDoc(F.doc(db, 'users', cred.user.uid), {
    email,
    displayName: displayName || '',
    initials: (initials || '').toUpperCase(),
    role: 'pending', // approved by an admin before they can read/write anything
    createdAt: now(),
  });
  try { await A.sendEmailVerification(cred.user); } catch { /* non-fatal */ }
  return getCurrentUser();
}

export async function signIn({ email, password }) {
  email = String(email).trim().toLowerCase();
  await A.signInWithEmailAndPassword(auth, email, password);
  return getCurrentUser();
}

export async function signOutUser() { await A.signOut(auth); }

export async function sendVerification() {
  if (auth.currentUser) await A.sendEmailVerification(auth.currentUser);
  return { sent: true };
}

export async function resetPassword(email) {
  await A.sendPasswordResetEmail(auth, String(email).trim().toLowerCase());
  return { sent: true };
}

export async function reloadUser() {
  if (auth.currentUser) {
    await auth.currentUser.reload();
    const fbUser = auth.currentUser;
    const profile = await ensureProfile(fbUser);
    _user = { uid: fbUser.uid, email: fbUser.email, emailVerified: fbUser.emailVerified, displayName: profile.displayName || '', initials: profile.initials || '', role: effectiveRole(fbUser.email, profile.role) };
    emitAuth();
  }
  return _user;
}

// ── Users (admin) ─────────────────────────────────────────────────────────────
export async function listUsers() {
  const snap = await F.getDocs(F.collection(db, 'users'));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.email || '').localeCompare(b.email || ''));
}

export async function setUserRole(uid, role) {
  await F.updateDoc(F.doc(db, 'users', uid), { role });
}

// ── Questions ─────────────────────────────────────────────────────────────────
async function nextHumanId() {
  const ref = F.doc(db, 'meta', 'counters');
  return F.runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists() ? (snap.data().humanId || 0) : 0;
    const next = cur + 1;
    tx.set(ref, { humanId: next }, { merge: true });
    return next;
  });
}

function requireUser() { if (!_user) throw new Error('Not signed in.'); return _user; }

export async function createQuestion(data) {
  const u = requireUser();
  const humanId = await nextHumanId();
  const q = {
    humanId,
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
  const ref = await F.addDoc(F.collection(db, 'questions'), q);
  return { id: ref.id, ...q };
}

export async function updateDraft(id, patch) {
  await F.updateDoc(F.doc(db, 'questions', id), { ...patch, updatedAt: now() });
}

export async function deleteQuestion(id) {
  await F.deleteDoc(F.doc(db, 'questions', id));
}

async function getQ(id) {
  const snap = await F.getDoc(F.doc(db, 'questions', id));
  if (!snap.exists()) throw new Error('Question not found.');
  return { id, ...snap.data() };
}

export async function submitForReview(id, patch = null) {
  const u = requireUser();
  const q = await getQ(id);
  const status = (q.status || 0) + 1;
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'submitted', comment: '', statusAt: status });
  await F.updateDoc(F.doc(db, 'questions', id), { ...(patch || {}), status, state: 'in_review', history, updatedAt: now() });
}

export async function requestChanges(id, comment) {
  const u = requireUser();
  const q = await getQ(id);
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'changes_requested', comment: comment || '', statusAt: q.status });
  await F.updateDoc(F.doc(db, 'questions', id), { state: 'changes_requested', history, updatedAt: now() });
}

export async function finalize(id, comment) {
  const u = requireUser();
  const q = await getQ(id);
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'finalized', comment: comment || '', statusAt: q.status });
  await F.updateDoc(F.doc(db, 'questions', id), { state: 'finalized', finalizedAt: now(), history, updatedAt: now() });
}

export async function addComment(id, comment) {
  const u = requireUser();
  const q = await getQ(id);
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'comment', comment: comment || '', statusAt: q.status });
  await F.updateDoc(F.doc(db, 'questions', id), { history, updatedAt: now() });
}

// ── Suggested edits ───────────────────────────────────────────────────────────
export async function addTextSuggestion(id, baseText, proposedText) {
  const u = requireUser();
  const q = await getQ(id);
  const suggestions = (q.suggestions || []).concat({
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    byUid: u.uid, byName: u.displayName || u.email, at: now(),
    status: 'pending', baseText: baseText ?? q.questionText, proposedText,
  });
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'suggestion', comment: '', statusAt: q.status });
  await F.updateDoc(F.doc(db, 'questions', id), { suggestions, history, updatedAt: now() });
}

export async function resolveSuggestion(id, sugId, action) {
  const u = requireUser();
  const q = await getQ(id);
  const suggestions = (q.suggestions || []).map((s) => s.id === sugId
    ? { ...s, status: action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'withdrawn', resolvedBy: u.uid, resolvedAt: now() }
    : s);
  const s = (q.suggestions || []).find((x) => x.id === sugId);
  if (!s) throw new Error('Suggestion not found.');
  const patch = { suggestions, updatedAt: now() };
  if (action === 'accept') {
    patch.questionText = s.proposedText;
    patch.history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'suggestion_accepted', comment: '', statusAt: q.status });
  } else if (action === 'reject') {
    patch.history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'suggestion_rejected', comment: '', statusAt: q.status });
  }
  await F.updateDoc(F.doc(db, 'questions', id), patch);
}

// ── Bulk import (CSV) ─────────────────────────────────────────────────────────
export async function bulkImport(questions, owner) {
  requireUser();
  let created = 0;
  // allocate a contiguous block of human IDs in one transaction
  const startId = await F.runTransaction(db, async (tx) => {
    const ref = F.doc(db, 'meta', 'counters');
    const snap = await tx.get(ref);
    const cur = snap.exists() ? (snap.data().humanId || 0) : 0;
    const next = cur + questions.length;
    tx.set(ref, { humanId: next }, { merge: true });
    return cur + 1;
  });
  let nextId = startId;
  let batch = F.writeBatch(db);
  let n = 0;
  for (const data of questions) {
    const ref = F.doc(F.collection(db, 'questions'));
    batch.set(ref, {
      humanId: nextId++,
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
    });
    created++;
    if (++n % 400 === 0) { await batch.commit(); batch = F.writeBatch(db); }
  }
  await batch.commit();
  return created;
}

export async function bulkUpsert(questions) {
  requireUser();
  let batch = F.writeBatch(db);
  let n = 0;
  for (const q of questions) {
    const { id, ...data } = q;
    const ref = id ? F.doc(db, 'questions', id) : F.doc(F.collection(db, 'questions'));
    batch.set(ref, data, { merge: true });
    if (++n % 400 === 0) { await batch.commit(); batch = F.writeBatch(db); }
  }
  await batch.commit();
  return questions.length;
}

export function watchOne(id, cb) {
  return F.onSnapshot(F.doc(db, 'questions', id), (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null));
}

export function watchQuestions(filter, cb) {
  const col = F.collection(db, 'questions');
  const clauses = [];
  if (filter.mine && _user) clauses.push(F.where('writerUid', '==', _user.uid));
  if (filter.finalized) clauses.push(F.where('state', '==', 'finalized'));
  else if (filter.states && filter.states.length === 1) clauses.push(F.where('state', '==', filter.states[0]));
  else if (filter.states) clauses.push(F.where('state', 'in', filter.states));

  const q = clauses.length ? F.query(col, ...clauses) : F.query(col);
  return F.onSnapshot(q, (snap) => {
    let arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (filter.excludeWriter && _user && CONFIG.hideOwnQuestionsFromReviewer) arr = arr.filter((x) => x.writerUid !== _user.uid);
    arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    cb(arr);
  }, (err) => { console.error('watchQuestions', err); cb([]); });
}

export const meta = { kind: 'firebase' };
