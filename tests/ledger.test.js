import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  canonicalJson, computeHash, appendLedgerEntry, verifyChain, readChain, tipHash,
} from '../src/ledger.js';
import { GENESIS_HASH } from '../src/config.js';

function freshDb() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO projects (code, title, budget, department, current_stage, stage_entered_at, created_at)
              VALUES ('P-1','Road', 100, 'PWD', 'DRAFT', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  return db;
}

const approval = (over = {}) => ({
  project_id: 1, stage: 'DRAFT', actor_role: 'JE', status: 'SUBMITTED',
  comment: '', timestamp: '2026-01-02T00:00:00.000Z', ...over,
});

test('canonicalJson sorts keys so payload order cannot change the hash', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ x: [3, { z: 1, y: 2 }] }), '{"x":[3,{"y":2,"z":1}]}');
  assert.equal(computeHash({ b: 1, a: 2 }, 'p'), computeHash({ a: 2, b: 1 }, 'p'));
});

test('computeHash is a 64-hex SHA-256 and depends on prev_hash', () => {
  const h = computeHash({ a: 1 }, GENESIS_HASH);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, computeHash({ a: 1 }, 'f'.repeat(64)));
  assert.equal(h, computeHash({ a: 1 }, GENESIS_HASH), 'must be deterministic');
});

test('empty chain: tip is genesis and verification passes vacuously', () => {
  const db = freshDb();
  assert.equal(tipHash(db), GENESIS_HASH);
  const r = verifyChain(db);
  assert.equal(r.valid, true);
  assert.equal(r.length, 0);
});

test('first entry links to genesis', () => {
  const db = freshDb();
  const e = appendLedgerEntry(db, 'APPROVAL', approval());
  assert.equal(e.seq, 1);
  assert.equal(e.prev_hash, GENESIS_HASH);
  assert.equal(tipHash(db), e.hash);
});

test('approvals and measurements share one chain in seq order', () => {
  const db = freshDb();
  const a = appendLedgerEntry(db, 'APPROVAL', approval());
  const m = appendLedgerEntry(db, 'MEASUREMENT', {
    project_id: 1, photo_url: '/u/1.jpg', lat: 23.02, lng: 72.57,
    note: 'chainage 0-500', actor_role: 'JE', timestamp: '2026-01-03T00:00:00.000Z',
  });
  const b = appendLedgerEntry(db, 'APPROVAL', approval({ stage: 'PENDING_DEE', actor_role: 'DEE', status: 'TECH_APPROVED' }));

  assert.deepEqual([a.seq, m.seq, b.seq], [1, 2, 3]);
  assert.equal(m.prev_hash, a.hash, 'measurement chains onto the approval');
  assert.equal(b.prev_hash, m.hash, 'approval chains onto the measurement');

  const chain = readChain(db);
  assert.deepEqual(chain.map(e => e.entry_type), ['APPROVAL', 'MEASUREMENT', 'APPROVAL']);
  assert.equal(verifyChain(db).valid, true);
});

test('a clean chain of many entries verifies', () => {
  const db = freshDb();
  for (let i = 0; i < 25; i++) appendLedgerEntry(db, 'APPROVAL', approval({ comment: `c${i}` }));
  const r = verifyChain(db);
  assert.equal(r.valid, true);
  assert.equal(r.length, 25);
  assert.equal(r.first_break, null);
  assert.equal(r.entries.every(e => e.ok), true);
});

test('tampering with a historical row is detected at that row', () => {
  const db = freshDb();
  appendLedgerEntry(db, 'APPROVAL', approval());
  appendLedgerEntry(db, 'APPROVAL', approval({ comment: 'budget verified: Rs 1,00,000' }));
  appendLedgerEntry(db, 'APPROVAL', approval({ comment: 'final approval' }));
  assert.equal(verifyChain(db).valid, true);

  // Someone edits the DB directly, behind the ledger's back.
  db.prepare(`UPDATE approvals SET comment = 'budget verified: Rs 10,00,000' WHERE seq = 2`).run();

  const r = verifyChain(db);
  assert.equal(r.valid, false);
  assert.equal(r.first_break, 2, 'break is reported at the edited row');
  assert.ok(r.breaks[0].reasons.includes('ALTERED_PAYLOAD'));
  assert.equal(r.entries.find(e => e.seq === 1).ok, true, 'earlier entries stay valid');
});

test('tampering with a stored hash breaks the link for the following entry', () => {
  const db = freshDb();
  appendLedgerEntry(db, 'APPROVAL', approval());
  appendLedgerEntry(db, 'APPROVAL', approval({ comment: 'second' }));

  db.prepare(`UPDATE approvals SET hash = ? WHERE seq = 1`).run('0'.repeat(63) + '1');

  const r = verifyChain(db);
  assert.equal(r.valid, false);
  assert.equal(r.first_break, 1);
  assert.ok(r.breaks[0].reasons.includes('ALTERED_PAYLOAD'));
  assert.ok(r.breaks.some(b => b.seq === 2 && b.reasons.includes('BROKEN_LINK')),
    'the next entry no longer links to it');
});

test('deleting a middle entry breaks the link', () => {
  const db = freshDb();
  appendLedgerEntry(db, 'APPROVAL', approval());
  appendLedgerEntry(db, 'APPROVAL', approval({ comment: 'two' }));
  appendLedgerEntry(db, 'APPROVAL', approval({ comment: 'three' }));

  db.prepare('DELETE FROM approvals WHERE seq = 2').run();

  const r = verifyChain(db);
  assert.equal(r.valid, false);
  assert.equal(r.first_break, 3);
  assert.ok(r.breaks[0].reasons.includes('BROKEN_LINK'));
});

test('measurement coordinates are covered by the hash', () => {
  const db = freshDb();
  appendLedgerEntry(db, 'MEASUREMENT', {
    project_id: 1, photo_url: '/u/a.jpg', lat: 23.0225, lng: 72.5714,
    note: 'pier 3', actor_role: 'JE', timestamp: '2026-01-04T00:00:00.000Z',
  });
  db.prepare('UPDATE measurements SET lat = 19.0760 WHERE seq = 1').run();

  const r = verifyChain(db);
  assert.equal(r.valid, false);
  assert.ok(r.breaks[0].reasons.includes('ALTERED_PAYLOAD'));
});

test('unknown entry type is rejected', () => {
  const db = freshDb();
  assert.throws(() => appendLedgerEntry(db, 'PAYMENT', {}), /Unknown ledger entry type/);
});
