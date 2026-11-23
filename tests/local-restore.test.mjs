// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs } from './helpers/browser-stubs.mjs';

installBrowserStubs();
const L = await import('../js/store/local.js');

const K_COMPILE = 'sbq_compile_drafts';
const drafts = () => JSON.parse(localStorage.getItem(K_COMPILE)) || [];

test('restoring rounds puts back saved rounds exactly and keeps newer ones', async () => {
  localStorage.setItem(K_COMPILE, JSON.stringify([
    { id: 'r1', name: 'Round 1 (edited since)', slots: [], order: 0, updatedAt: 50 },
    { id: 'r3', name: 'Made after the backup', slots: [], order: 2, updatedAt: 60 },
  ]));
  const saved = [
    { id: 'r1', name: 'Round 1', slots: [{ tu: 'q1', b: 'q2' }], composition: ['Bio'], order: 0, updatedAt: 10, createdAt: 1, createdByUid: 'u1' },
    { id: 'r2', name: 'Round 2 (deleted since)', slots: [{ tu: 'q3' }], order: 1, updatedAt: 11, createdAt: 2 },
  ];
  const seen = [];
  const stop = L.watchCompileDrafts((rows) => seen.push(rows.length));
  const n = await L.restoreCompileDrafts(saved);
  stop();
  assert.equal(n, 2);
  const byId = Object.fromEntries(drafts().map((x) => [x.id, x]));
  assert.deepEqual(byId.r1, saved[0]);
  assert.deepEqual(byId.r2, saved[1]);
  assert.equal(byId.r3.name, 'Made after the backup');
  assert.equal(seen.at(-1), 3, 'compile listeners notified');
});

test('restoring an empty list of rounds changes nothing', async () => {
  const before = localStorage.getItem(K_COMPILE);
  assert.equal(await L.restoreCompileDrafts([]), 0);
  assert.equal(localStorage.getItem(K_COMPILE), before);
});
