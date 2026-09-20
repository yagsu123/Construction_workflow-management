#!/usr/bin/env node
// Demo dataset. Wipes and rebuilds the database, then replays a realistic history
// through the real workflow functions - so every ledger entry is genuinely hashed and
// anchored, exactly as if a person had clicked it.
//
//   npm run seed
//
// Times are backdated so the delay dashboard has something to say.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { getDb, resetDb } from '../src/db.js';
import { actorId } from '../src/auth.js';
import { appendLedgerEntry, setAnchorSink } from '../src/ledger.js';
import { writeAnchor } from '../src/anchor.js';
import { ANCHOR_PATH } from '../src/config.js';

const db = getDb();
resetDb(db);
fs.rmSync(ANCHOR_PATH, { force: true });        // a fresh chain needs a fresh anchor log
setAnchorSink((len, tip) => writeAnchor(len, tip));

// The placeholder site photo is written FIRST and hashed for real, so seeded e-MB entries
// pass the same photo-integrity check as uploaded ones. Seeding a fake hash would light up
// every seeded entry as "photo swapped" - which is exactly what the stress test caught.
const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <rect width="240" height="240" fill="#8a9099"/>
  <rect y="150" width="240" height="90" fill="#6b7178"/>
  <rect y="146" width="240" height="6" fill="#f0c23a"/>
  <text x="120" y="120" font-family="sans-serif" font-size="15" fill="#fff" text-anchor="middle">seed site photo</text>
</svg>`;
fs.mkdirSync('public/uploads', { recursive: true });
fs.writeFileSync('public/uploads/seed-site-photo.svg', PLACEHOLDER);
const PHOTO_URL = '/uploads/seed-site-photo.svg';
const PHOTO_SHA = createHash('sha256').update(Buffer.from(PLACEHOLDER)).digest('hex');

const DAY = 86_400_000;
const ago = d => new Date(Date.now() - d * DAY).toISOString();

function project({ code, title, budget, department, contractor, stage, enteredDaysAgo, createdDaysAgo }) {
  return Number(db.prepare(`
    INSERT INTO projects (code, title, budget, department, contractor, current_stage, stage_entered_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, title, budget, department, contractor, stage, ago(enteredDaysAgo), ago(createdDaysAgo)).lastInsertRowid);
}

// The same accounts the login page offers, so seeded history and live clicks look identical.
const ACCOUNT = { JE: 'je.patel', AE: 'ae.shah', FIN: 'fin.desai', EE: 'ee.mehta' };

const approve = (id, stage, role, status, comment, daysAgo) =>
  appendLedgerEntry(db, 'APPROVAL', {
    project_id: id, stage, actor_role: role, actor_user: actorId(ACCOUNT[role]),
    status, comment, timestamp: ago(daysAgo),
  });

const emb = (id, lat, lng, note, daysAgo) =>
  appendLedgerEntry(db, 'MEASUREMENT', {
    project_id: id, photo_url: PHOTO_URL, photo_sha256: PHOTO_SHA,
    lat, lng, note, actor_role: 'JE', actor_user: actorId(ACCOUNT.JE), timestamp: ago(daysAgo),
  });

// ── 1. The star of the demo: rotting at the AE test-check ────────────────────────────────────
const p1 = project({
  code: 'PWD/2026/001', title: 'Widening of SH-41, km 12 to km 19',
  budget: 24_500_000, department: 'Public Works Department (Roads)',
  contractor: 'M/s Patel Infra Pvt Ltd',
  stage: 'PENDING_AE', enteredDaysAgo: 23, createdDaysAgo: 34,
});
emb(p1, 23.02250, 72.57140, 'BT layer laid, chainage 12.4 to 13.1 km', 26);
emb(p1, 23.03910, 72.59880, 'Culvert at km 14.2, shuttering removed', 25);
approve(p1, 'DRAFT', 'JE', 'SUBMITTED', 'RA bill 1 — 30% completion, 2 e-MB entries attached', 23);

// ── 2. Was sent back by the AE, now resubmitted and moving ───────────────────────────────────
const p2 = project({
  code: 'PWD/2026/002', title: 'Reconstruction of storm water drain, Sector 14',
  budget: 8_750_000, department: 'Urban Development',
  contractor: 'M/s Shah Constructions',
  stage: 'PENDING_FINANCE', enteredDaysAgo: 9, createdDaysAgo: 41,
});
emb(p2, 23.21560, 72.63410, 'Drain invert level, chainage 0 to 240 m', 30);
approve(p2, 'DRAFT', 'JE', 'SUBMITTED', 'RA bill 1 — 40% completion', 28);
approve(p2, 'PENDING_AE', 'AE', 'REJECTED', 'Re-measured chainage 180–240 m: invert 40 mm above drawing. Returned for correction.', 24);
emb(p2, 23.21560, 72.63410, 'Invert corrected and re-laid, chainage 180 to 240 m', 14);
approve(p2, 'DRAFT', 'JE', 'SUBMITTED', 'Corrected as per AE remarks, re-measured', 12);
approve(p2, 'PENDING_AE', 'AE', 'TEST_CHECKED', '50% re-measured, now tallies with e-MB', 9);

// ── 3. Stuck at Finance, just past SLA ───────────────────────────────────────────────────────
const p3 = project({
  code: 'PWD/2026/003', title: 'Construction of 2 additional classrooms, Govt. School, Dholka',
  budget: 4_200_000, department: 'Public Works Department (Buildings)',
  contractor: 'M/s Vyas Builders',
  stage: 'PENDING_FINANCE', enteredDaysAgo: 11, createdDaysAgo: 22,
});
emb(p3, 22.72640, 72.46150, 'RCC slab cast, both rooms', 16);
approve(p3, 'DRAFT', 'JE', 'SUBMITTED', 'RA bill 2 — 60% completion', 14);
approve(p3, 'PENDING_AE', 'AE', 'TEST_CHECKED', 'Slab thickness and reinforcement verified on site', 11);

// ── 4. Ready to click through live on stage: sitting with the EE ─────────────────────────────
const p4 = project({
  code: 'PWD/2026/004', title: 'Strengthening of approach road to Kadi APMC',
  budget: 15_800_000, department: 'Public Works Department (Roads)',
  contractor: 'M/s Trivedi Roadways',
  stage: 'PENDING_EE', enteredDaysAgo: 2, createdDaysAgo: 19,
});
emb(p4, 23.29840, 72.33190, 'WMM layer complete, chainage 0 to 1.8 km', 12);
emb(p4, 23.30510, 72.34020, 'Compaction test points, chainage 1.8 to 2.4 km', 10);
approve(p4, 'DRAFT', 'JE', 'SUBMITTED', 'RA bill 1 — 35% completion', 8);
approve(p4, 'PENDING_AE', 'AE', 'TEST_CHECKED', '30% re-measured, WMM thickness as per specification', 5);
approve(p4, 'PENDING_FINANCE', 'FIN', 'VERIFIED', 'Budget head BE-2026-41 confirmed, within sanctioned estimate', 2);

// ── 5. Completed end to end — the full chain to point at ─────────────────────────────────────
const p5 = project({
  code: 'PWD/2026/005', title: 'Repairs to Panchayat Bhavan, Viramgam',
  budget: 1_950_000, department: 'Rural Development',
  contractor: 'M/s Desai & Sons',
  stage: 'PAYMENT_TRIGGERED', enteredDaysAgo: 1, createdDaysAgo: 27,
});
emb(p5, 23.11920, 72.03780, 'Roof waterproofing complete, plaster repairs done', 15);
approve(p5, 'DRAFT', 'JE', 'SUBMITTED', 'Final bill — 100% completion', 13);
approve(p5, 'PENDING_AE', 'AE', 'TEST_CHECKED', 'Full re-measure, quantities tally', 10);
approve(p5, 'PENDING_FINANCE', 'FIN', 'VERIFIED', 'Budget head BE-2026-07, final bill within estimate', 6);
approve(p5, 'PENDING_EE', 'EE', 'APPROVED', 'Approved for final payment', 3);
approve(p5, 'APPROVED', 'EE', 'PAYMENT_TRIGGERED', 'Smart contract executed — disbursement request raised', 1);

const counts = db.prepare(`SELECT
  (SELECT COUNT(*) FROM projects) AS projects,
  (SELECT COUNT(*) FROM approvals) AS approvals,
  (SELECT COUNT(*) FROM measurements) AS measurements`).get();

console.log(`\n  Seeded ${counts.projects} projects, ${counts.approvals} approvals, ${counts.measurements} e-MB entries.\n`);
console.log(`    PWD/2026/001  PENDING_AE        23 days  <- past SLA, the demo's headline`);
console.log(`    PWD/2026/002  PENDING_FINANCE    9 days  <- was rejected by the AE, then fixed`);
console.log(`    PWD/2026/003  PENDING_FINANCE   11 days  <- past SLA`);
console.log(`    PWD/2026/004  PENDING_EE         2 days  <- click this through live`);
console.log(`    PWD/2026/005  PAYMENT_TRIGGERED  1 day   <- full chain, start to finish\n`);
console.log(`  Now run:  npm start   then open http://localhost:3000\n`);
