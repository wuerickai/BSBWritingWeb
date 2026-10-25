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
import { mergeEdit } from '../text.js';
import { allCapsPreservingLatex } from '../latex.js';

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

async function userShape(fbUser, profile) {
  const token = await A.getIdTokenResult(fbUser);
  const providerIds = fbUser.providerData.map((p) => p.providerId).filter(Boolean);
  return {
    uid: fbUser.uid,
    email: fbUser.email,
    // Google has already authenticated the user. Treat a current Google session
    // as verified even if a Workspace-domain account has not yet propagated the
    // Firebase user-level emailVerified flag.
    emailVerified: fbUser.emailVerified || token.signInProvider === 'google.com',
    displayName: profile.displayName || fbUser.displayName || '',
    initials: profile.initials || '',
    role: effectiveRole(fbUser.email, profile.role),
    providerIds,
  };
}

function googleProvider(email = '') {
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({
    hd: 'berkeley.edu',
    prompt: 'select_account',
    ...(email ? { login_hint: email } : {}),
  });
  return provider;
}

export async function init() {
  const appMod = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  A = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
  F = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
  app = appMod.initializeApp(CONFIG.firebase);
  auth = A.getAuth(app);
  // Persist the cache in IndexedDB so a reload (or a second tab) resumes the
  // all-questions listener with a resume token and is billed only for documents
  // that changed, instead of re-reading the whole collection.
  try {
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch (e) {
    console.warn('Firestore persistent cache unavailable; using memory cache', e);
    db = F.getFirestore(app);
  }

  A.onAuthStateChanged(auth, async (fbUser) => {
    if (!fbUser) { _user = null; emitAuth(); return; }
    const profile = await ensureProfile(fbUser);
    _user = await userShape(fbUser, profile);
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

export async function signInWithGoogle() {
  await A.signInWithPopup(auth, googleProvider());
  return reloadUser();
}

export async function linkGoogleAccount() {
  const fbUser = auth.currentUser;
  if (!fbUser) throw new Error('Sign in with your existing account first.');
  const uid = fbUser.uid;
  const result = await A.linkWithPopup(fbUser, googleProvider(fbUser.email || ''));
  if (result.user.uid !== uid) throw new Error('Google linking returned a different account. Your existing account was not replaced.');
  await result.user.reload();
  await A.getIdToken(result.user, true);
  return reloadUser();
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
    // Force a fresh ID token. reload() updates the local User object's
    // emailVerified flag but does NOT mint a new ID token — and Firestore
    // security rules only ever see the token's email_verified claim. Without
    // this, a just-verified email/password user keeps sending a token with
    // email_verified:false, so verified() fails and every question write is
    // denied for up to an hour (even after an admin approves them as a writer).
    try { await A.getIdToken(auth.currentUser, true); } catch { /* non-fatal */ }
    const fbUser = auth.currentUser;
    const profile = await ensureProfile(fbUser);
    _user = await userShape(fbUser, profile);
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
    mcAnswerText: data.mcAnswerText || '',
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

// Admin edit of any question (including finalized ones). Records a history entry
// and never changes the question's state. Allowed by firestore.rules for admins.
export async function adminEdit(id, patch) {
  const u = requireUser();
  const q = await getQ(id);
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'edited', comment: '', statusAt: q.status });
  await F.updateDoc(F.doc(db, 'questions', id), { ...patch, history, updatedAt: now() });
}

// Edit of someone else's question by any approved member (from the Compile view).
// Only the question's content changes — never its state, author, or review count
// — and the edit is logged in the history. firestore.rules limits this to
// non-finalized questions and to the content fields below.
export async function peerEdit(id, patch) {
  const u = requireUser();
  const q = await getQ(id);
  const allowed = ['tub', 'subject', 'subcat', 'type', 'questionText', 'answerLine', 'choices', 'mcAnswer', 'mcAnswerText', 'difficulty', 'source'];
  const data = Object.fromEntries(allowed.filter((k) => k in patch).map((k) => [k, patch[k]]));
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'peer_edited', comment: '', statusAt: q.status });
  await F.updateDoc(F.doc(db, 'questions', id), { ...data, history, updatedAt: now() });
}

export async function deleteQuestion(id) {
  await F.deleteDoc(F.doc(db, 'questions', id));
  return { removedFrom: await removeFromCompileDrafts(id) };
}

// Take a question out of every round draft it's placed in (used when it goes
// to the Graveyard or is deleted), so it never comes back into a round on its
// own — e.g. after a restore. Returns the affected drafts' names, or null if
// the drafts couldn't be updated (the archive/delete itself still stands).
export async function removeFromCompileDrafts(id) {
  try {
    const u = requireUser();
    const snap = await F.getDocs(draftsQuery());
    const names = [];
    for (const d of snap.docs) {
      const data = d.data();
      const slots = Array.isArray(data.slots) ? data.slots : [];
      if (!slots.some((s) => s.tu === id || s.b === id)) continue;
      await F.updateDoc(d.ref, {
        slots: slots.map((s) => ({ ...s, tu: s.tu === id ? null : s.tu, b: s.b === id ? null : s.b })),
        updatedAt: now(), updatedByUid: u.uid, updatedByName: u.displayName || u.email,
      });
      names.push(data.name || 'Untitled draft');
    }
    try { await F.deleteDoc(claimRef(id)); } catch { /* none, or not allowed */ }
    return names;
  } catch (e) {
    console.error('removeFromCompileDrafts', e);
    return null;
  }
}

// ── Graveyard (soft-remove) ───────────────────────────────────────────────────
// Archive keeps the record (and its original `state`) but takes it out of every
// list; restore puts it back. firestore.rules allows any approved user to
// archive/restore a NON-finalized question and reserves finalized ones to admins.
export async function archiveQuestion(id, reason) {
  const u = requireUser();
  const q = await getQ(id);
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'archived', comment: reason || '', statusAt: q.status });
  await F.updateDoc(F.doc(db, 'questions', id), {
    archived: true, archivedAt: now(), archivedBy: u.uid, archivedByName: u.displayName || u.email, archivedReason: reason || '',
    history, updatedAt: now(),
  });
  return { removedFrom: await removeFromCompileDrafts(id) };
}

export async function restoreQuestion(id) {
  const u = requireUser();
  const q = await getQ(id);
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'restored', comment: '', statusAt: q.status });
  await F.updateDoc(F.doc(db, 'questions', id), {
    archived: false, archivedAt: null, archivedBy: null, archivedReason: '',
    history, updatedAt: now(),
  });
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

// Reviewer signs off on a question without requesting changes: bumps the review
// count (status) and keeps it in the queue for the next pass — a lighter-weight
// alternative to sending it back to the writer.
export async function approveReview(id, comment) {
  const u = requireUser();
  const q = await getQ(id);
  const status = (q.status || 0) + 1;
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'approved', comment: comment || '', statusAt: status });
  await F.updateDoc(F.doc(db, 'questions', id), { status, state: 'in_review', history, updatedAt: now() });
}

export async function finalize(id, comment) {
  const u = requireUser();
  const q = await getQ(id);
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'finalized', comment: comment || '', statusAt: q.status });
  await F.updateDoc(F.doc(db, 'questions', id), { state: 'finalized', finalizedAt: now(), history, updatedAt: now() });
}

// Admin reversal of finalize: sends the question back into the review queue
// (state in_review, status unchanged) and clears finalizedAt.
export async function unfinalize(id, comment) {
  const u = requireUser();
  const q = await getQ(id);
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'unfinalized', comment: comment || '', statusAt: q.status });
  await F.updateDoc(F.doc(db, 'questions', id), { state: 'in_review', finalizedAt: null, history, updatedAt: now() });
}

export async function addComment(id, comment) {
  const u = requireUser();
  const q = await getQ(id);
  const history = (q.history || []).concat({ at: now(), byUid: u.uid, byName: u.displayName || u.email, action: 'comment', comment: comment || '', statusAt: q.status });
  await F.updateDoc(F.doc(db, 'questions', id), { history, updatedAt: now() });
}

// ── Suggested edits (text, MC choices, difficulty) ───────────────────────────
export async function addSuggestion(id, payload) {
  const u = requireUser();
  const q = await getQ(id);
  const suggestions = (q.suggestions || []).concat({
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    byUid: u.uid, byName: u.displayName || u.email, at: now(),
    status: 'pending', ...payload,
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
    // Merge text edits onto the CURRENT text so multiple accepted suggestions
    // compose instead of the last one clobbering the earlier ones.
    if (s.proposedText != null) {
      patch.questionText = mergeEdit(s.baseText, s.proposedText, q.questionText).text;
    }
    if (s.proposedChoices) {
      patch.choices = { ...(q.choices || {}) };
      for (const [slot, val] of Object.entries(s.proposedChoices)) patch.choices[slot] = val;
    }
    if (s.proposedAnswerLine != null) {
      patch.answerLine = mergeEdit(s.baseAnswerLine, s.proposedAnswerLine, q.answerLine).text;
    }
    if (s.proposedMcAnswer != null) patch.mcAnswer = s.proposedMcAnswer;
    if (s.proposedDifficulty != null) patch.difficulty = s.proposedDifficulty;
    // The correct MC choice keeps its natural-case wording; the ALL-CAPS reading
    // lives separately in mcAnswerText. Recompute it whenever a suggestion
    // changed the correct choice or its wording.
    const finalMc = patch.mcAnswer ?? q.mcAnswer;
    const finalChoices = patch.choices || q.choices || {};
    if (q.type === 'MC' && finalMc && finalChoices[finalMc] != null) {
      patch.mcAnswerText = allCapsPreservingLatex(finalChoices[finalMc]);
    }
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
      mcAnswerText: data.type === 'MC' && data.mcAnswer && data.choices?.[data.mcAnswer]
        ? allCapsPreservingLatex(data.choices[data.mcAnswer]) : '',
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

// ── Compile round drafts (shared among admins) ────────────────────────────────
// Each round draft is one document in `compileDrafts`. Any admin sees and edits
// the shared set; which draft tabs a person has open is per-device UI state kept
// in the client's localStorage, not here. firestore.rules restricts this
// collection to admins (the Compile view is admin-only).
// Only the fields present on `data` are written to an existing draft (setDoc
// merges), so autosaving the working copy never clobbers a rename made elsewhere
// and renaming never touches the contents. A new draft gets every field.
const DRAFT_DEFAULTS = { name: 'Untitled draft', composition: [], slots: [], roundNumber: '' };
function draftShape(u, data, isNew) {
  const out = {};
  for (const [k, dflt] of Object.entries(DRAFT_DEFAULTS)) {
    if (isNew || data[k] !== undefined) out[k] = data[k] || dflt;
  }
  for (const k of ['shuffle', 'fullDoc']) {
    if (isNew || data[k] !== undefined) out[k] = data[k] !== false;
  }
  if (Number.isFinite(data.order)) out.order = data.order; // shared position (admins set it)
  out.updatedAt = now();
  out.updatedByUid = u.uid;
  out.updatedByName = u.displayName || u.email;
  return out;
}

// ── Where Compile data lives ──────────────────────────────────────────────────
// Round drafts and placement claims are stored as documents in the `meta`
// collection (meta/compileDraft_<id>, meta/compileClaim_<questionId>), which the
// live security rules already let every approved member read and write (the
// question-number counter lives there too). That way all users can work in
// Compile without a rules change. Admin-only actions (creating, deleting and
// reordering drafts) are limited by the app, not by the database.
// Drafts saved before this lived in `compileDrafts`, which only admins can read;
// migrateLegacyCompileDrafts() copies them over (see watchCompileDrafts).
const META = 'meta';
const draftRef = (id) => F.doc(db, META, 'compileDraft_' + id);
const claimRef = (questionId) => F.doc(db, META, 'compileClaim_' + questionId);
const draftsQuery = () => F.query(F.collection(db, META), F.where('kind', '==', 'compileDraft'));
const draftFromDoc = (d) => ({ ...d.data(), id: d.data().draftId || d.id.replace(/^compileDraft_/, '') });

// ── One round per question: placement claims ─────────────────────────────────
// Before a question goes into a round draft, the person placing it claims it
// (compileClaims/{questionId} → { draftId, at }). Claiming is atomic, so two
// people can't both win the same question for different drafts, even within the
// second before either draft saves. A claim lapses on its own once its draft no
// longer holds the question: the draft is gone, or the person who claimed it
// has saved that draft since without the question. A save by someone else
// doesn't count — their copy may simply not include the new placement yet.
// Removing a question from a draft releases its claim right away (see
// releaseClaim); anything left over lapses after CLAIM_GRACE_MS.
const CLAIM_GRACE_MS = 10 * 60 * 1000;
function claimHolds(claim, draft, questionId) {
  if (!draft) return false;
  if ((draft.slots || []).some((s) => s.tu === questionId || s.b === questionId)) return true;
  const savedSinceByClaimer = (draft.updatedAt || 0) > (claim.at || 0) && !!claim.byUid && draft.updatedByUid === claim.byUid;
  return !savedSinceByClaimer && now() - (claim.at || 0) < CLAIM_GRACE_MS;
}

// Resolves { ok: true } once `questionId` is claimed for `draftId`, or
// { ok: false, draftName } if another draft holds it.
export async function claimForDraft(questionId, draftId) {
  const u = requireUser();
  const ref = claimRef(questionId);
  return F.runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) {
      const c = snap.data();
      if (c.draftId && c.draftId !== draftId) {
        const dSnap = await tx.get(draftRef(c.draftId));
        const draft = dSnap.exists() ? dSnap.data() : null;
        if (claimHolds(c, draft, questionId)) return { ok: false, draftName: draft.name || 'another draft' };
      }
    }
    tx.set(ref, { kind: 'compileClaim', questionId, draftId, at: now(), byUid: u.uid, byName: u.displayName || u.email });
    return { ok: true };
  });
}

// Drop this draft's claim on a question (best effort; claims also lapse alone).
export async function releaseClaim(questionId, draftId) {
  try {
    const ref = claimRef(questionId);
    await F.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists() && snap.data().draftId === draftId) tx.delete(ref);
    });
  } catch (e) { console.error('releaseClaim', e); }
}

export async function saveCompileDraft(draft) {
  const u = requireUser();
  const isNew = !draft.id;
  // A new draft gets a fresh id (generated locally; nothing is written there).
  const id = draft.id || F.doc(F.collection(db, 'compileDrafts')).id;
  const data = draftShape(u, draft, isNew);
  data.kind = 'compileDraft';
  data.draftId = id;
  if (isNew) {
    data.createdAt = now();
    data.createdByUid = u.uid;
    data.createdByName = u.displayName || u.email;
  }
  await F.setDoc(draftRef(id), data, { merge: true });
  return { id, ...data };
}

// Admin: save the shared draft order (ids first → last). Only `order` changes —
// not updatedAt — so reordering never looks like an edit to a round's contents.
export async function reorderCompileDrafts(ids) {
  const batch = F.writeBatch(db);
  ids.forEach((id, i) => batch.update(draftRef(id), { order: i }));
  await batch.commit();
}

export async function deleteCompileDraft(id) {
  await F.deleteDoc(draftRef(id));
}

// Copy drafts saved in the old `compileDrafts` collection into `meta`, once
// each (the old copy is flagged `migratedToMeta` so a later delete in `meta`
// doesn't bring it back). Only admins can read `compileDrafts` under the live
// rules, so for anyone else this is a quiet no-op; the first admin to open
// Compile brings the existing drafts over for everyone.
let _migration = null;
function migrateLegacyCompileDrafts() {
  if (!_migration) {
    _migration = (async () => {
      let snap;
      try { snap = await F.getDocs(F.collection(db, 'compileDrafts')); }
      catch { _migration = null; return; } // not allowed for this account — try again next time
      for (const d of snap.docs) {
        const data = d.data();
        if (data.migratedToMeta) continue;
        try {
          const target = draftRef(d.id);
          const existing = await F.getDoc(target);
          if (!existing.exists()) await F.setDoc(target, { ...data, kind: 'compileDraft', draftId: d.id });
          await F.updateDoc(d.ref, { migratedToMeta: true });
        } catch (e) { console.error('migrate compile draft', d.id, e); }
      }
    })();
  }
  return _migration;
}

export function watchCompileDrafts(cb) {
  // Like watchQuestions: skip stale IndexedDB snapshots until the server confirms,
  // or Compile would load an old copy of the active draft (and autosave it back
  // over newer edits) or, on an empty cache, seed a spurious "Draft 1".
  // Old drafts are copied over first, so an admin never sees an empty list and
  // seeds a new draft while the existing ones are still being moved.
  let stop = null, cancelled = false;
  migrateLegacyCompileDrafts().finally(() => {
    if (cancelled) return;
    let synced = false;
    stop = F.onSnapshot(draftsQuery(), { includeMetadataChanges: true }, (snap) => {
      if (!synced) {
        if (snap.metadata.fromCache) return;
        synced = true;
      } else if (!snap.docChanges().length) return; // metadata-only (e.g. pending write acked)
      const arr = snap.docs.map(draftFromDoc);
      arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      cb(arr);
    }, (err) => { console.error('watchCompileDrafts', err); cb([]); });
  });
  return () => { cancelled = true; if (stop) stop(); };
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
  // With the persistent cache the first snapshot may be a stale copy from
  // IndexedDB. Hold callbacks until the server has confirmed the result set so
  // views (e.g. Compile hydrating draft slots by id) never act on missing docs.
  // Metadata changes must be included, or the cache→server flip with no doc
  // changes would never fire.
  let synced = false;
  return F.onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    if (!synced) {
      if (snap.metadata.fromCache) return;
      synced = true;
    } else if (!snap.docChanges().length) return; // metadata-only (e.g. pending write acked)
    let arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Archived questions live only in the Graveyard. `archived` may be missing on
    // older docs, so filter client-side rather than with a where() clause.
    if (filter.archived) arr = arr.filter((x) => x.archived === true);
    else if (!filter.includeArchived) arr = arr.filter((x) => !x.archived);
    if (filter.excludeWriter && _user && CONFIG.hideOwnQuestionsFromReviewer) arr = arr.filter((x) => x.writerUid !== _user.uid);
    arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    cb(arr);
  }, (err) => { console.error('watchQuestions', err); cb([]); });
}

export const meta = { kind: 'firebase' };
