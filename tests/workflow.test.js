import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { verifyChain } from '../src/ledger.js';
import { act, createProject, decorate, actionsFor } from '../src/workflow.js';
import { STAGE_ORDER, ROLE_IDS } from '../src/config.js';

function freshDb() {
  const db = openDb(':memory:');
  createProject(db, { title: 'Widening of SH-41', budget: 24500000, department: 'PWD (Roads)' });
  return db;
}
const stage = db => db.prepare('SELECT current_stage FROM projects WHERE id = 1').get().current_stage;

test('all five roles are configured', () => {
  assert.deepEqual(ROLE_IDS, ['CONTRACTOR', 'JE', 'AE', 'DEE', 'EE']);
});

test('the AE test-check sits between the JE and the DEE', () => {
  assert.deepEqual(STAGE_ORDER, [
    'DRAFT', 'PENDING_JE', 'PENDING_AE', 'PENDING_DEE', 'PENDING_EE', 'APPROVED', 'PAYMENT_TRIGGERED',
  ]);
});

test('happy path runs CONTRACTOR -> JE -> AE -> DEE -> EE -> smart contract', () => {
  const db = freshDb();
  assert.equal(stage(db), 'DRAFT');
  act(db, { projectId: 1, role: 'CONTRACTOR', action: 'submit_ra' });
  assert.equal(stage(db), 'PENDING_JE');
  act(db, { projectId: 1, role: 'JE',  action: 'submit' });
  assert.equal(stage(db), 'PENDING_AE');
  act(db, { projectId: 1, role: 'AE',  action: 'test_check', comment: '30% re-measured, tallies' });
  assert.equal(stage(db), 'PENDING_DEE');
  act(db, { projectId: 1, role: 'DEE', action: 'tech_approve' });
  assert.equal(stage(db), 'PENDING_EE');
  act(db, { projectId: 1, role: 'EE',  action: 'approve', dsc_pin: '1234' });
  assert.equal(stage(db), 'APPROVED');
  act(db, { projectId: 1, role: 'EE',  action: 'trigger_payment' });
  assert.equal(stage(db), 'PAYMENT_TRIGGERED');

  const chain = verifyChain(db);
  assert.equal(chain.valid, true);
  assert.deepEqual(chain.entries.map(e => e.status),
    ['RA_SUBMITTED', 'SUBMITTED', 'TEST_CHECKED', 'TECH_APPROVED', 'APPROVED', 'PAYMENT_TRIGGERED']);
});

test('the DEE cannot reach a file still awaiting the AE test-check', () => {
  const db = freshDb();
  act(db, { projectId: 1, role: 'CONTRACTOR', action: 'submit_ra' });
  act(db, { projectId: 1, role: 'JE', action: 'submit' });
  assert.throws(() => act(db, { projectId: 1, role: 'DEE', action: 'tech_approve' }),
    /it is with AE/, 'the AE gate cannot be bypassed');
  assert.equal(stage(db), 'PENDING_AE');
});

test('an AE measurement mismatch sends the file back to the JE and is ledgered', () => {
  const db = freshDb();
  act(db, { projectId: 1, role: 'CONTRACTOR', action: 'submit_ra' });
  act(db, { projectId: 1, role: 'JE', action: 'submit' });
  act(db, { projectId: 1, role: 'AE', action: 'reject', comment: 'Chainage 12.8 short by 40 m on re-measure' });

  assert.equal(stage(db), 'PENDING_JE');
  const entries = verifyChain(db).entries;
  assert.equal(entries.at(-1).status, 'REJECTED');
  assert.equal(entries.at(-1).actor_role, 'AE');
  assert.match(entries.at(-1).comment, /short by 40 m/);
  assert.equal(verifyChain(db).valid, true);
});

test('the AE must give a reason when rejecting', () => {
  const db = freshDb();
  act(db, { projectId: 1, role: 'CONTRACTOR', action: 'submit_ra' });
  act(db, { projectId: 1, role: 'JE', action: 'submit' });
  assert.throws(() => act(db, { projectId: 1, role: 'AE', action: 'reject' }), /reason is required/);
});

test('each stage offers actions to exactly one role', () => {
  for (const s of STAGE_ORDER) {
    const holders = ROLE_IDS.filter(r => actionsFor(s, r).length > 0);
    assert.ok(holders.length <= 1, `stage ${s} is actionable by ${holders.join(', ')}`);
  }
});

test('days_in_stage and the overdue flag track the current stage', () => {
  const db = freshDb();
  db.prepare(`UPDATE projects SET stage_entered_at = ?, created_at = ? WHERE id = 1`)
    .run(new Date(Date.now() - 11 * 86400000).toISOString(), new Date(Date.now() - 11 * 86400000).toISOString());

  const p = decorate(db, db.prepare('SELECT * FROM projects WHERE id = 1').get());
  assert.equal(p.days_in_stage, 11);
  assert.equal(p.overdue, true);
  assert.equal(p.waiting_on, 'CONTRACTOR');

  act(db, { projectId: 1, role: 'CONTRACTOR', action: 'submit_ra' });
  const q = decorate(db, db.prepare('SELECT * FROM projects WHERE id = 1').get());
  assert.equal(q.days_in_stage, 0, 'the clock restarts when the file moves');
  assert.equal(q.overdue, true, 'the project is still overdue overall');
  assert.equal(q.waiting_on, 'JE');
});
