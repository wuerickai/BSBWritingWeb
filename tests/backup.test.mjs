// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs } from './helpers/browser-stubs.mjs';

installBrowserStubs();
const Backup = await import('../js/backup.js');

const q = (id, updatedAt = 1) => ({ id, humanId: Number(id.slice(1)), updatedAt, questionText: 'Q ' + id });
const d = (id, extra = {}) => ({ id, name: 'Round ' + id, slots: [{ tu: 'q1', b: 'q2' }], composition: [], updatedAt: 5, order: 0, ...extra });

let questions = [q('q1'), q('q2')];
let drafts = [d('r1'), d('r2', { order: 1 })];
Backup.configure(() => questions, () => drafts);

test('a snapshot holds the compiled rounds as well as the questions', async () => {
  const at = await Backup.snapshotNow();
  assert.ok(at, 'snapshot taken');
  const listed = Backup.listSnapshots().find((s) => s.at === at);
  assert.equal(listed.count, 2);
  assert.equal(listed.draftCount, 2);
  const snap = await Backup.getSnapshotData(at);
  assert.deepEqual(snap.questions.map((x) => x.id), ['q1', 'q2']);
  assert.deepEqual(snap.drafts.map((x) => x.id), ['r1', 'r2']);
  assert.deepEqual(snap.drafts[0].slots, [{ tu: 'q1', b: 'q2' }]);
});

test('nothing changed → no new snapshot', async () => {
  assert.equal(await Backup.snapshotNow(), null);
});

test('editing a round (without touching questions) takes a new snapshot', async () => {
  drafts = [d('r1', { updatedAt: 9, slots: [] }), drafts[1]];
  const at = await Backup.snapshotNow();
  assert.ok(at, 'snapshot taken after a draft edit');
  assert.deepEqual((await Backup.getSnapshotData(at)).drafts[0].slots, []);
});

test('reordering rounds (order only, updatedAt unchanged) takes a new snapshot', async () => {
  await new Promise((r) => setTimeout(r, 2)); // distinct `at` key
  drafts = [{ ...drafts[0], order: 1 }, { ...drafts[1], order: 0 }];
  assert.ok(await Backup.snapshotNow(), 'snapshot taken after reorder');
});

test('deleting a round takes a new snapshot', async () => {
  await new Promise((r) => setTimeout(r, 2));
  drafts = drafts.slice(0, 1);
  const at = await Backup.snapshotNow();
  assert.ok(at);
  assert.equal(Backup.listSnapshots().find((s) => s.at === at).draftCount, 1);
});

test('snapshots made before rounds were backed up still read as questions-only', async () => {
  // Simulate an old record: { at, count, data } with no drafts field.
  const req = indexedDB.open('sbq-backups', 1);
  await new Promise((r) => { req.onsuccess = r; });
  const old = { at: 1000, count: 1, data: [q('q9')] };
  await new Promise((r) => { req.result.transaction('snapshots', 'readwrite').objectStore('snapshots').put(old).onsuccess = r; });
  const snap = await Backup.getSnapshotData(1000);
  assert.deepEqual(snap.questions.map((x) => x.id), ['q9']);
  assert.deepEqual(snap.drafts, []);
});

test('downloaded file contains questions and rounds, and parses back', () => {
  const file = Backup.toBackupFile({ at: 123, questions: [q('q1')], drafts: [d('r1')] });
  assert.equal(file.format, 'sbq-backup');
  assert.equal(file.version, 2);
  const parsed = Backup.parseBackup(JSON.parse(JSON.stringify(file)));
  assert.deepEqual(parsed.questions.map((x) => x.id), ['q1']);
  assert.deepEqual(parsed.drafts.map((x) => x.id), ['r1']);
});

test('older downloads (a bare array of questions) still parse', () => {
  const parsed = Backup.parseBackup([q('q1'), q('q2')]);
  assert.equal(parsed.questions.length, 2);
  assert.deepEqual(parsed.drafts, []);
});

test('files that are not backups are rejected', () => {
  assert.throws(() => Backup.parseBackup({ hello: 'world' }));
  assert.throws(() => Backup.parseBackup([{ nope: true }]));
  assert.throws(() => Backup.parseBackup(null));
  assert.throws(() => Backup.parseBackup({ format: 'sbq-backup', questions: [q('q1')], drafts: [{ name: 'no id' }] }));
});
