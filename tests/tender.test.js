import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { verifyChain } from '../src/ledger.js';
import {
  createPackage, revisePackage, actOnTender, getTender, packageFingerprint, tenderEvents,
} from '../src/tender.js';
import { getProject } from '../src/workflow.js';

const BOQ = [
  { description: 'Earthwork in excavation', unit: 'cum', quantity: 1200, rate: 185 },
  { description: 'WBM Grade II', unit: 'cum', quantity: 430, rate: 2100 },
];

const PACKAGE = {
  role: 'JE', actorUser: 'je',
  title: 'Widening of SH-41, km 12 to km 19',
  department: 'Public Works Department (Roads)',
  scope: 'Widening of 7 km of two-lane carriageway to intermediate lane standard.',
  boq: BOQ,
  estimated_cost: 24_500_000,
  completion_days: 240,
  emd_amount: 490_000,
  eligibility: 'Class I(A) contractors with one similar work of 40% value in the last 5 years',
  aa_reference: 'AA/RB/2026/118',
  site_lat: 23.0225, site_lng: 72.5714,
};

const db_ = () => openDb(':memory:');

/** Walk a fresh package all the way to a published ITT. */
function publish(db) {
  const { tender } = createPackage(db, PACKAGE);
  actOnTender(db, { tenderId: tender.id, role: 'JE', action: 'submit_package' });
  actOnTender(db, { tenderId: tender.id, role: 'DEE', action: 'scrutinise' });
  actOnTender(db, { tenderId: tender.id, role: 'EE', action: 'accord_ts', budget_head: 'BE-2026-41' });
  actOnTender(db, {
    tenderId: tender.id, role: 'EE', action: 'publish_itt', dsc_pin: '1234',
    bid_due_date: new Date(Date.now() + 21 * 86_400_000).toISOString(),
  });
  return tender.id;
}

// --- creating the package -----------------------------------------------------------------------

test('a package needs an Administrative Approval reference', () => {
  const db = db_();
  assert.throws(() => createPackage(db, { ...PACKAGE, aa_reference: '' }), /Administrative Approval/);
});

test('a package needs at least one BOQ item', () => {
  const db = db_();
  assert.throws(() => createPackage(db, { ...PACKAGE, boq: [] }), /BOQ item/);
});

test('the EE cannot write the estimate he will later sanction', () => {
  const db = db_();
  assert.throws(() => createPackage(db, { ...PACKAGE, role: 'EE' }), /prepared by the JE or the AE/);
});

test('packages are numbered NIT/<year>/nnn', () => {
  const db = db_();
  const a = createPackage(db, PACKAGE).tender;
  const b = createPackage(db, PACKAGE).tender;
  const year = new Date().getFullYear();
  assert.equal(a.code, `NIT/${year}/001`);
  assert.equal(b.code, `NIT/${year}/002`);
});

// --- the gates ----------------------------------------------------------------------------------

test('the gates run JE -> DEE -> EE sanction -> EE publication', () => {
  const db = db_();
  const id = publish(db);
  const t = getTender(db, id);
  assert.equal(t.status, 'PUBLISHED');
  assert.equal(t.budget_head, 'BE-2026-41');
  assert.ok(t.itt_published_at);

  assert.deepEqual(tenderEvents(db, id).map(e => e.event), [
    'PACKAGE_CREATED', 'SUBMITTED_FOR_SCRUTINY', 'SUB_DIVISIONAL_APPROVAL',
    'TECHNICAL_SANCTION', 'ITT_PUBLISHED',
  ]);
});

test('the DEE cannot sanction, and the EE cannot scrutinise on the DEE\'s behalf', () => {
  const db = db_();
  const { tender } = createPackage(db, PACKAGE);
  actOnTender(db, { tenderId: tender.id, role: 'JE', action: 'submit_package' });
  assert.throws(() => actOnTender(db, { tenderId: tender.id, role: 'EE', action: 'scrutinise' }),
    /it is with the DEE/);
});

test('a package cannot skip DEE scrutiny on its way to Technical Sanction', () => {
  const db = db_();
  const { tender } = createPackage(db, PACKAGE);
  actOnTender(db, { tenderId: tender.id, role: 'JE', action: 'submit_package' });
  assert.throws(() => actOnTender(db, { tenderId: tender.id, role: 'EE', action: 'accord_ts', budget_head: 'X' }),
    /cannot "accord_ts"/);
});

test('Technical Sanction requires a budget head', () => {
  const db = db_();
  const { tender } = createPackage(db, PACKAGE);
  actOnTender(db, { tenderId: tender.id, role: 'JE', action: 'submit_package' });
  actOnTender(db, { tenderId: tender.id, role: 'DEE', action: 'scrutinise' });
  assert.throws(() => actOnTender(db, { tenderId: tender.id, role: 'EE', action: 'accord_ts' }),
    /budget head/);
});

test('publication is signed — a wrong DSC PIN publishes nothing', () => {
  const db = db_();
  const { tender } = createPackage(db, PACKAGE);
  actOnTender(db, { tenderId: tender.id, role: 'JE', action: 'submit_package' });
  actOnTender(db, { tenderId: tender.id, role: 'DEE', action: 'scrutinise' });
  actOnTender(db, { tenderId: tender.id, role: 'EE', action: 'accord_ts', budget_head: 'BE-1' });
  assert.throws(() => actOnTender(db, {
    tenderId: tender.id, role: 'EE', action: 'publish_itt', dsc_pin: '9999',
    bid_due_date: new Date(Date.now() + 86_400_000).toISOString(),
  }), /DSC PIN/);
  assert.equal(getTender(db, tender.id).status, 'PENDING_PUBLISH');
});

test('an ITT cannot close before it opens', () => {
  const db = db_();
  const { tender } = createPackage(db, PACKAGE);
  actOnTender(db, { tenderId: tender.id, role: 'JE', action: 'submit_package' });
  actOnTender(db, { tenderId: tender.id, role: 'DEE', action: 'scrutinise' });
  actOnTender(db, { tenderId: tender.id, role: 'EE', action: 'accord_ts', budget_head: 'BE-1' });
  assert.throws(() => actOnTender(db, {
    tenderId: tender.id, role: 'EE', action: 'publish_itt', dsc_pin: '1234',
    bid_due_date: new Date(Date.now() - 86_400_000).toISOString(),
  }), /must be in the future/);
});

test('a return must carry a reason, and that reason goes on the ledger', () => {
  const db = db_();
  const { tender } = createPackage(db, PACKAGE);
  actOnTender(db, { tenderId: tender.id, role: 'JE', action: 'submit_package' });
  assert.throws(() => actOnTender(db, { tenderId: tender.id, role: 'DEE', action: 'return' }), /needs a reason/);

  actOnTender(db, {
    tenderId: tender.id, role: 'DEE', action: 'return',
    comment: 'WBM quantity does not match the cross-sections',
  });
  assert.equal(getTender(db, tender.id).status, 'PACKAGE_DRAFT');
  const last = tenderEvents(db, tender.id).at(-1);
  assert.equal(last.event, 'RETURNED_BY_DEE');
  assert.match(last.comment, /cross-sections/);
});

// --- the package fingerprint ---------------------------------------------------------------------

test('the fingerprint tracks what bidders price, not who is holding the file', () => {
  const db = db_();
  const { tender } = createPackage(db, PACKAGE);
  const sealed = getTender(db, tender.id).package_sha256;

  // Moving through a gate must not change the fingerprint.
  actOnTender(db, { tenderId: tender.id, role: 'JE', action: 'submit_package' });
  assert.equal(getTender(db, tender.id).package_sha256, sealed);

  // Changing a BOQ quantity must.
  actOnTender(db, { tenderId: tender.id, role: 'DEE', action: 'return', comment: 'revise quantities' });
  revisePackage(db, {
    tenderId: tender.id, role: 'JE',
    patch: { boq: [{ ...BOQ[0], quantity: 1500 }, BOQ[1]] },
  });
  assert.notEqual(getTender(db, tender.id).package_sha256, sealed);
});

test('a published package can no longer be edited', () => {
  const db = db_();
  const id = publish(db);
  assert.throws(() => revisePackage(db, { tenderId: id, role: 'JE', patch: { estimated_cost: 1 } }),
    /can no longer be edited/);
});

test('a revision that changes nothing does not clutter the chain', () => {
  const db = db_();
  const { tender } = createPackage(db, PACKAGE);
  const before = tenderEvents(db, tender.id).length;
  const r = revisePackage(db, { tenderId: tender.id, role: 'JE', patch: { scope: PACKAGE.scope } });
  assert.equal(r.entry, null);
  assert.equal(tenderEvents(db, tender.id).length, before);
});

// --- award --------------------------------------------------------------------------------------

test('the work order creates the project at DRAFT, carrying the tendered figures', () => {
  const db = db_();
  const id = publish(db);
  const { project } = actOnTender(db, {
    tenderId: id, role: 'EE', action: 'award', contractor: 'Sardar Constructions Pvt Ltd',
  });

  assert.equal(project.current_stage, 'DRAFT');
  assert.equal(project.budget, PACKAGE.estimated_cost);
  assert.equal(project.contractor, 'Sardar Constructions Pvt Ltd');
  assert.equal(project.site_lat, PACKAGE.site_lat);

  const t = getTender(db, id);
  assert.equal(t.status, 'AWARDED');
  assert.equal(t.project_id, project.id);
  assert.equal(getProject(db, project.id).title, PACKAGE.title);
});

test('a work order needs the contractor on record', () => {
  const db = db_();
  const id = publish(db);
  assert.throws(() => actOnTender(db, { tenderId: id, role: 'EE', action: 'award' }), /contractor on record/);
});

// --- the chain ------------------------------------------------------------------------------------

test('tender events share the one chain and it verifies', () => {
  const db = db_();
  const id = publish(db);
  actOnTender(db, { tenderId: id, role: 'EE', action: 'award', contractor: 'Sardar Constructions' });

  const chain = verifyChain(db);
  assert.equal(chain.valid, true);
  assert.equal(chain.length, 6);
  assert.ok(chain.entries.every(e => e.entry_type === 'TENDER_EVENT'));
});

test('revising the sealed package after publication is detectable', () => {
  const db = db_();
  const id = publish(db);
  const sealed = getTender(db, id).package_sha256;

  // Go behind the application and inflate a BOQ quantity, exactly as scope creep would.
  const boq = JSON.parse(getTender(db, id).boq_json);
  boq[0].quantity = 9999;
  db.prepare('UPDATE tenders SET boq_json = ? WHERE id = ?').run(JSON.stringify(boq), id);

  const now = packageFingerprint(getTender(db, id));
  assert.notEqual(now, sealed, 'the package no longer matches what was published');
  assert.equal(tenderEvents(db, id).at(-1).package_sha256, sealed,
    'the ledger still holds the fingerprint bidders were shown');
});
