// ────────────────────────────────────────────────────────────────────────────
//  Periodic local backups of all questions and compiled round drafts.
//  Snapshot DATA ({ at, count, draftCount, data: questions[], drafts: [] }) is
//  stored in IndexedDB (large quota); a small INDEX of {at, count, draftCount}
//  lives in localStorage so listing is cheap. Snapshots from before rounds were
//  included have no `drafts` and read back as questions-only.
//  Placement claims aren't saved: a claim holds whenever its draft contains the
//  question, so restoring the drafts brings their claims back with them. Snapshots are taken on
//  an interval, after imports/mutations (debounced), and before the page unloads.
// ────────────────────────────────────────────────────────────────────────────

import { CONFIG } from './config.js';

const DB_NAME = 'sbq-backups';
const STORE = 'snapshots';
const IDX_KEY = 'sbq_backup_index';

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'at' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode) { return db().then((d) => d.transaction(STORE, mode).objectStore(STORE)); }
const idxRead = () => { try { return JSON.parse(localStorage.getItem(IDX_KEY)) || []; } catch { return []; } };
const idxWrite = (a) => localStorage.setItem(IDX_KEY, JSON.stringify(a));

export function listSnapshots() {
  return idxRead().slice().sort((a, b) => b.at - a.at);
}

async function putSnapshot(snap) {
  const store = await tx('readwrite');
  await new Promise((res, rej) => { const r = store.put(snap); r.onsuccess = res; r.onerror = () => rej(r.error); });
}
async function getSnapshot(at) {
  const store = await tx('readonly');
  return new Promise((res, rej) => { const r = store.get(at); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function delSnapshot(at) {
  const store = await tx('readwrite');
  await new Promise((res) => { const r = store.delete(at); r.onsuccess = res; r.onerror = res; });
}

let _getAll = () => [];
let _getDrafts = () => [];
let _lastHash = '';
let _timer = null;
let _debounce = null;

export function configure(getAll, getDrafts) {
  _getAll = getAll;
  if (getDrafts) _getDrafts = getDrafts;
}

const sumMod = (arr, f) => arr.reduce((h, x) => (h + f(x)) % 2147483647, 0);
function fingerprint(data, drafts) {
  // Reordering rounds changes only `order`, not updatedAt, so include it.
  return data.length + ':' + sumMod(data, (q) => q.updatedAt || 0)
    + '|' + drafts.length + ':' + sumMod(drafts, (d) => d.updatedAt || 0)
    + ':' + drafts.map((d) => d.id + '@' + (d.order ?? '')).join(',');
}

export async function snapshotNow({ force = false } = {}) {
  let data, drafts;
  try { data = _getAll() || []; } catch { return null; }
  try { drafts = _getDrafts() || []; } catch { drafts = []; }
  if (!data.length && !force) return null;
  const hash = fingerprint(data, drafts);
  if (hash === _lastHash && !force) return null; // nothing changed
  _lastHash = hash;
  let at = Date.now();
  const idx = idxRead();
  while (idx.some((s) => s.at === at)) at += 1; // keys must be unique
  const snap = { at, count: data.length, draftCount: drafts.length, data, drafts };
  try {
    await putSnapshot(snap);
    idx.push({ at, count: data.length, draftCount: drafts.length });
    // prune oldest beyond keep
    idx.sort((a, b) => a.at - b.at);
    while (idx.length > (CONFIG.backup?.keep || 20)) {
      const old = idx.shift();
      await delSnapshot(old.at);
    }
    idxWrite(idx);
    document.dispatchEvent(new CustomEvent('sbq-backup'));
    return at;
  } catch (e) { console.warn('backup failed', e); return null; }
}

// Call this after mutations; coalesces rapid changes into one snapshot.
export function markDirty() {
  clearTimeout(_debounce);
  _debounce = setTimeout(() => snapshotNow(), 4000);
}

export function start(getAll, getDrafts) {
  configure(getAll, getDrafts);
  stop();
  const mins = CONFIG.backup?.intervalMinutes || 10;
  _timer = setInterval(() => snapshotNow(), Math.max(1, mins) * 60 * 1000);
  window.addEventListener('beforeunload', () => { try { snapshotNow(); } catch {} });
  snapshotNow(); // initial (no-op until questions have loaded)
}
export function stop() { if (_timer) clearInterval(_timer); _timer = null; }

// → { at, questions, drafts } (drafts is [] for snapshots that predate them), or null.
export async function getSnapshotData(at) {
  const s = await getSnapshot(at);
  return s ? { at: s.at, questions: s.data || [], drafts: s.drafts || [] } : null;
}

// ── Backup files (download / restore from file) ──────────────────────────────
export function toBackupFile({ at = Date.now(), questions = [], drafts = [] }) {
  return { format: 'sbq-backup', version: 2, at, questions, drafts };
}

// Accepts a file made by toBackupFile, or an older download (a bare array of
// questions). Returns { at, questions, drafts }; throws if it isn't a backup.
export function parseBackup(json) {
  let questions, drafts = [], at = null;
  if (Array.isArray(json)) questions = json;
  else if (json && json.format === 'sbq-backup' && Array.isArray(json.questions)) {
    questions = json.questions;
    drafts = Array.isArray(json.drafts) ? json.drafts : [];
    at = json.at || null;
  } else throw new Error('This file is not a question bank backup.');
  const hasId = (x) => x && typeof x === 'object' && typeof x.id === 'string' && x.id;
  if (!questions.every(hasId)) throw new Error('This backup has questions without an ID.');
  if (!drafts.every(hasId)) throw new Error('This backup has rounds without an ID.');
  return { at, questions, drafts };
}

export function downloadJson(data, name) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
