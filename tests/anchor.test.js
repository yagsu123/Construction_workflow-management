import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { appendLedgerEntry, verifyChain, computeHash, approvalPayload, setAnchorSink } from '../src/ledger.js';
import { writeAnchor, readAnchors, checkAnchors } from '../src/anchor.js';

function scratch() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-')), 'anchors.log');
}

function seeded(anchorPath) {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO projects (code,title,budget,department,current_stage,stage_entered_at,created_at)
              VALUES ('P','Road',100,'PWD','DRAFT','t','t')`).run();
  setAnchorSink((len, tip) => writeAnchor(len, tip, anchorPath));
  for (const comment of ['submitted', 'budget verified: Rs 1,00,000', 'approved']) {
    appendLedgerEntry(db, 'APPROVAL', {
      project_id: 1, stage: 'DRAFT', actor_role: 'FIN', status: 'VERIFIED', comment,
    });
  }
  setAnchorSink(null);
  return db;
}

test('an anchor is published for every ledger append', () => {
  const p = scratch();
  seeded(p);
  const anchors = readAnchors(p);
  assert.equal(anchors.length, 3);
  assert.deepEqual(anchors.map(a => a.length), [1, 2, 3]);
  assert.ok(anchors.every(a => /^[0-9a-f]{64}$/.test(a.tip)));
});

test('an untouched chain matches its anchors', () => {
  const p = scratch();
  const db = seeded(p);
  const r = checkAnchors(db, p);
  assert.equal(r.valid, true);
  assert.equal(r.checked, 3);
});

test('THE ONE THAT MATTERS: a fully re-signed chain is caught by the anchors', () => {
  const p = scratch();
  const db = seeded(p);

  // Alter a historical row, then recompute every hash from genesis so the chain is
  // internally perfect again — the attack that defeats the hash chain on its own.
  db.prepare(`UPDATE approvals SET comment = 'budget verified: Rs 10,00,000' WHERE seq = 2`).run();
  let prev = '0'.repeat(64);
  for (const row of db.prepare('SELECT * FROM approvals ORDER BY seq').all()) {
    const hash = computeHash(approvalPayload(row), prev);
    db.prepare('UPDATE approvals SET prev_hash = ?, hash = ? WHERE seq = ?').run(prev, hash, row.seq);
    prev = hash;
  }

  assert.equal(verifyChain(db).valid, true, 'the chain alone cannot see this — that is the point');

  const r = checkAnchors(db, p);
  assert.equal(r.valid, false, 'the anchors must catch it');
  assert.equal(r.mismatches[0].length, 2, 'caught at the first altered length');
  assert.equal(r.mismatches[0].reason, 'TIP_MISMATCH');
});

test('deleting entries to shorten the chain is caught', () => {
  const p = scratch();
  const db = seeded(p);
  db.prepare('DELETE FROM approvals WHERE seq = 3').run();

  const r = checkAnchors(db, p);
  assert.equal(r.valid, false);
  assert.ok(r.mismatches.some(m => m.reason === 'CHAIN_SHORTER_THAN_ANCHOR'));
});

test('no anchor log means no anchor claim, not a false pass', () => {
  const db = openDb(':memory:');
  const r = checkAnchors(db, path.join(os.tmpdir(), 'definitely-not-here', 'anchors.log'));
  assert.deepEqual(r, { checked: 0, valid: true, mismatches: [] });
});

test('a corrupt line in the anchor log is skipped, not fatal', () => {
  const p = scratch();
  const db = seeded(p);
  fs.appendFileSync(p, 'this is not json\n');
  assert.equal(readAnchors(p).length, 3);
  assert.equal(checkAnchors(db, p).valid, true);
});
