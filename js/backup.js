// ────────────────────────────────────────────────────────────────────────────
//  Periodic local backups of all questions.
//  Snapshot DATA is stored in IndexedDB (large quota); a small INDEX of
//  {at, count} lives in localStorage so listing is cheap. Snapshots are taken on
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
let _lastHash = '';
let _timer = null;
let _debounce = null;

export function configure(getAll) { _getAll = getAll; }

export async function snapshotNow({ force = false } = {}) {
  let data;
  try { data = _getAll() || []; } catch { return null; }
  if (!data.length && !force) return null;
  const hash = data.length + ':' + data.reduce((h, q) => (h + (q.updatedAt || 0)) % 2147483647, 0);
  if (hash === _lastHash && !force) return null; // nothing changed
  _lastHash = hash;
  const at = Date.now();
  const snap = { at, count: data.length, data };
  try {
    await putSnapshot(snap);
    const idx = idxRead();
    idx.push({ at, count: data.length });
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

export function start(getAll) {
  configure(getAll);
  stop();
  const mins = CONFIG.backup?.intervalMinutes || 10;
  _timer = setInterval(() => snapshotNow(), Math.max(1, mins) * 60 * 1000);
  window.addEventListener('beforeunload', () => { try { snapshotNow(); } catch {} });
  snapshotNow(); // initial (no-op until questions have loaded)
}
export function stop() { if (_timer) clearInterval(_timer); _timer = null; }

export async function getSnapshotData(at) {
  const s = await getSnapshot(at);
  return s ? s.data : null;
}

export function downloadJson(data, name) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
