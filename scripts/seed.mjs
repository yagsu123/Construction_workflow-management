#!/usr/bin/env node
// Demo dataset. Wipes and rebuilds the database, then replays a realistic history
// through the real workflow functions - so every ledger entry is genuinely hashed and
// anchored, exactly as if a person had clicked it.
//
//   npm run seed
//
// Times are backdated so the delay dashboard has something to say.

import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { getDb, resetDb } from '../src/db.js';
import { actorId } from '../src/auth.js';
import { readExif } from '../src/exif.js';
import { daysBetween } from '../src/delays.js';
// Reusing the test fixture deliberately: it builds a genuine EXIF block, so seeded photos go
// through exactly the same verification path as a real upload rather than being special-cased.
import { makeJpegWithExif } from '../tests/fixtures/jpeg.js';
import { appendLedgerEntry, setAnchorSink } from '../src/ledger.js';
import { createPackage, actOnTender } from '../src/tender.js';
import { DSC_PIN } from '../src/config.js';
import { writeAnchor } from '../src/anchor.js';
import { ANCHOR_PATH } from '../src/config.js';
import { haversineMetres } from '../src/geo.js';

const db = getDb();
resetDb(db);
fs.rmSync(ANCHOR_PATH, { force: true });        // a fresh chain needs a fresh anchor log
setAnchorSink((len, tip) => writeAnchor(len, tip));

// Seeded photos are written FIRST and hashed for real, so they pass the same integrity and
// EXIF checks as an uploaded one. Seeding a fake hash would light up every seeded entry as
// "photo swapped" - which is exactly what the stress test caught once already.
fs.mkdirSync('public/uploads', { recursive: true });

/** A real JPEG carrying real EXIF GPS at the given point. Returns what the ledger needs. */
function sitePhoto(lat, lng, daysAgo) {
  const t = new Date(Date.now() - daysAgo * 86_400_000);
  const p = n => String(n).padStart(2, '0');
  const stamp = `${t.getUTCFullYear()}:${p(t.getUTCMonth() + 1)}:${p(t.getUTCDate())} ` +
                `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
  const buf = makeJpegWithExif({ lat, lng, takenAt: stamp, make: 'Redmi', model: 'Note 12' });
  const sha = createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(`public/uploads/${sha}.jpg`, buf);
  return { url: `/uploads/${sha}.jpg`, sha, exif: readExif(buf) };
}

/** A photo with no EXIF at all — so the demo shows an UNVERIFIED entry too. */
const STRIPPED = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]),
]);
const STRIPPED_SHA = createHash('sha256').update(STRIPPED).digest('hex');
fs.writeFileSync(`public/uploads/${STRIPPED_SHA}.jpg`, STRIPPED);

const DAY = 86_400_000;
const ago = d => new Date(Date.now() - d * DAY).toISOString();

function project({ code, title, budget, department, contractor, stage, enteredDaysAgo,
                   createdDaysAgo, site }) {
  return Number(db.prepare(`
    INSERT INTO projects (code, title, budget, department, contractor,
                          site_lat, site_lng, site_radius_m,
                          current_stage, stage_entered_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, title, budget, department, contractor,
         site?.lat ?? null, site?.lng ?? null, site?.radius ?? null,
         stage, ago(enteredDaysAgo), ago(createdDaysAgo)).lastInsertRowid);
}

// The same accounts the login page offers, so seeded history and live clicks look identical.
const ACCOUNT = { CONTRACTOR: 'contractor.ltd', JE: 'je.patel', AE: 'ae.shah', DEE: 'dee.desai', EE: 'ee.mehta' };

const approve = (id, stage, role, status, comment, daysAgo) =>
  appendLedgerEntry(db, 'APPROVAL', {
    project_id: id, stage, actor_role: role, actor_user: actorId(ACCOUNT[role]),
    status, comment, timestamp: ago(daysAgo),
  });

/** A verified e-MB entry: real photo, real EXIF GPS at the same point. */
function emb(id, lat, lng, note, daysAgo, { verified = true } = {}) {
  const site = db.prepare('SELECT site_lat, site_lng FROM projects WHERE id = ?').get(id);
  const distance_m = site?.site_lat != null
    ? Math.round(haversineMetres(lat, lng, site.site_lat, site.site_lng)) : null;

  if (!verified) {
    return appendLedgerEntry(db, 'MEASUREMENT', {
      project_id: id, photo_url: `/uploads/${STRIPPED_SHA}.jpg`, photo_sha256: STRIPPED_SHA,
      lat, lng, note, actor_role: 'JE', actor_user: actorId(ACCOUNT.JE),
      exif_lat: null, exif_lng: null, exif_taken_at: null,
      photo_verified: 'UNVERIFIED', distance_m, timestamp: ago(daysAgo),
    });
  }

  const photo = sitePhoto(lat, lng, daysAgo);
  return appendLedgerEntry(db, 'MEASUREMENT', {
    project_id: id, photo_url: photo.url, photo_sha256: photo.sha,
    lat, lng, note, actor_role: 'JE', actor_user: actorId(ACCOUNT.JE),
    exif_lat: photo.exif.lat, exif_lng: photo.exif.lng, exif_taken_at: photo.exif.taken_at,
    photo_verified: 'EXIF_CONFIRMED', distance_m, timestamp: ago(daysAgo),
  });
}

// ── 1. The star of the demo: rotting at the AE test-check ────────────────────────────────────
const p1 = project({
  code: 'PWD/2026/001', title: 'Widening of SH-41, km 12 to km 19',
  budget: 24_500_000, department: 'Public Works Department (Roads)',
  contractor: 'M/s Patel Infra Pvt Ltd',
  stage: 'PENDING_AE', enteredDaysAgo: 23, createdDaysAgo: 34,
  site: { lat: 23.02250, lng: 72.57140, radius: 2500 },   // a 7 km road package
});
emb(p1, 23.02250, 72.57140, 'BT layer laid, chainage 12.4 to 13.1 km', 26);
emb(p1, 23.03910, 72.59880, 'Culvert at km 14.2, shuttering removed', 25);
approve(p1, 'DRAFT', 'CONTRACTOR', 'RA_SUBMITTED', 'RA bill 1 — 30% completion', 24);
approve(p1, 'PENDING_JE', 'JE', 'SUBMITTED', 'RA bill 1 — 30% completion, 2 e-MB entries attached', 23);

// ── 2. Was sent back by the AE, now resubmitted and moving ───────────────────────────────────
const p2 = project({
  code: 'PWD/2026/002', title: 'Reconstruction of storm water drain, Sector 14',
  budget: 8_750_000, department: 'Urban Development',
  contractor: 'M/s Shah Constructions',
  stage: 'PENDING_DEE', enteredDaysAgo: 9, createdDaysAgo: 41,
  site: { lat: 23.21560, lng: 72.63410, radius: 400 },
});
emb(p2, 23.21560, 72.63410, 'Drain invert level, chainage 0 to 240 m', 30);
approve(p2, 'DRAFT', 'CONTRACTOR', 'RA_SUBMITTED', 'RA bill 1 — 40% completion', 29);
approve(p2, 'PENDING_JE', 'JE', 'SUBMITTED', 'RA bill 1 — 40% completion', 28);
approve(p2, 'PENDING_AE', 'AE', 'REJECTED', 'Re-measured chainage 180–240 m: invert 40 mm above drawing. Returned for correction.', 24);
emb(p2, 23.21560, 72.63410, 'Invert corrected and re-laid, chainage 180 to 240 m', 14);
approve(p2, 'PENDING_JE', 'JE', 'SUBMITTED', 'Corrected as per AE remarks, re-measured', 12);
approve(p2, 'PENDING_AE', 'AE', 'TEST_CHECKED', '50% re-measured, now tallies with e-MB', 9);

// ── 3. Stuck at DEE technical approval, just past SLA ───────────────────────────────────────────────────────
const p3 = project({
  code: 'PWD/2026/003', title: 'Construction of 2 additional classrooms, Govt. School, Dholka',
  budget: 4_200_000, department: 'Public Works Department (Buildings)',
  contractor: 'M/s Vyas Builders',
  stage: 'PENDING_DEE', enteredDaysAgo: 11, createdDaysAgo: 22,
  site: { lat: 22.72640, lng: 72.46150, radius: 150 },    // a school building
});
emb(p3, 22.72640, 72.46150, 'RCC slab cast, both rooms', 16, { verified: false });
approve(p3, 'DRAFT', 'CONTRACTOR', 'RA_SUBMITTED', 'RA bill 2 — 60% completion', 15);
approve(p3, 'PENDING_JE', 'JE', 'SUBMITTED', 'RA bill 2 — 60% completion', 14);
approve(p3, 'PENDING_AE', 'AE', 'TEST_CHECKED', 'Slab thickness and reinforcement verified on site', 11);

// ── 4. Ready to click through live on stage: sitting with the EE ─────────────────────────────
const p4 = project({
  code: 'PWD/2026/004', title: 'Strengthening of approach road to Kadi APMC',
  budget: 15_800_000, department: 'Public Works Department (Roads)',
  contractor: 'M/s Trivedi Roadways',
  stage: 'PENDING_EE', enteredDaysAgo: 2, createdDaysAgo: 19,
  site: { lat: 23.29840, lng: 72.33190, radius: 3000 },
});
emb(p4, 23.29840, 72.33190, 'WMM layer complete, chainage 0 to 1.8 km', 12);
emb(p4, 23.30510, 72.34020, 'Compaction test points, chainage 1.8 to 2.4 km', 10);
approve(p4, 'DRAFT', 'CONTRACTOR', 'RA_SUBMITTED', 'RA bill 1 — 35% completion', 9);
approve(p4, 'PENDING_JE', 'JE', 'SUBMITTED', 'RA bill 1 — 35% completion', 8);
approve(p4, 'PENDING_AE', 'AE', 'TEST_CHECKED', '30% re-measured, WMM thickness as per specification', 5);
approve(p4, 'PENDING_DEE', 'DEE', 'TECH_APPROVED', 'Test-checked 30% of items at site; sub-divisional technical approval accorded', 2);

// ── 5. Completed end to end — the full chain to point at ─────────────────────────────────────
const p5 = project({
  code: 'PWD/2026/005', title: 'Repairs to Panchayat Bhavan, Viramgam',
  budget: 1_950_000, department: 'Rural Development',
  contractor: 'M/s Desai & Sons',
  stage: 'PAYMENT_TRIGGERED', enteredDaysAgo: 1, createdDaysAgo: 27,
  site: { lat: 23.11920, lng: 72.03780, radius: 150 },
});
emb(p5, 23.11920, 72.03780, 'Roof waterproofing complete, plaster repairs done', 15);
approve(p5, 'DRAFT', 'CONTRACTOR', 'RA_SUBMITTED', 'Final bill — 100% completion', 14);
approve(p5, 'PENDING_JE', 'JE', 'SUBMITTED', 'Final bill — 100% completion', 13);
approve(p5, 'PENDING_AE', 'AE', 'TEST_CHECKED', 'Full re-measure, quantities tally', 10);
approve(p5, 'PENDING_DEE', 'DEE', 'TECH_APPROVED', 'Test-checked 30% of final bill items; technical approval accorded', 6);
approve(p5, 'PENDING_EE', 'EE', 'APPROVED', 'Approved for final payment', 3);
approve(p5, 'APPROVED', 'EE', 'PAYMENT_TRIGGERED', 'Smart contract executed — disbursement request raised', 1);

// ── ground delay: why the WORK stopped, as distinct from which desk the file is on ───────────
const hold = (id, code, party, excusable, remarks, fromDaysAgo, toDaysAgo = null) =>
  appendLedgerEntry(db, 'DELAY_LOG', {
    id: randomUUID(),
    project_id: id,
    reported_by_role: 'JE',
    delay_category: code,
    delay_responsibility: party,
    start_date: ago(fromDaysAgo),
    estimated_end_date: null,
    actual_end_date: toDaysAgo === null ? null : ago(toDaysAgo),
    impact_days: toDaysAgo === null ? daysBetween(ago(fromDaysAgo), new Date().toISOString()) : daysBetween(ago(fromDaysAgo), ago(toDaysAgo)),
    description: remarks,
    status: toDaysAgo === null ? 'ACTIVE' : 'RESOLVED',
    actor_user: actorId(ACCOUNT.JE),
    timestamp: ago(fromDaysAgo),
  });

// 001 is late at the AE test-check AND held on site — the honest case. Two open holds.
hold(p1, 'LAND_ACQUISITION', 'EXTERNAL', true,
     '3 plots at km 14.2 under dispute; award not yet declared', 31);
hold(p1, 'UTILITY_SHIFTING', 'EXTERNAL', true,
     '11 kV line along km 15.0–15.6 awaiting shifting by the electricity board', 18);

// 002 lost a monsoon month, now closed — shows delay that has been resolved.
hold(p2, 'WEATHER', 'EXTERNAL', true, 'Work suspended, unworkable ground after heavy rain', 36, 22);

// 003 is the uncomfortable one: the department's own budget release.
hold(p3, 'FUNDS_AWAITED', 'DEPARTMENT', true, 'Budget head BE-2026-07 release pending at Division', 13);

// 004 had a contractor problem, since resolved — not excusable, so LD applies.
hold(p4, 'MATERIAL_SHORTAGE', 'CONTRACTOR', false, 'Bitumen supply interrupted by the contractor', 14, 7);

// ── tenders: the procurement side, so the ITT gates have something to show ───────────────────
//
// Three packages, each parked at a different gate, so every role has one waiting for them.
const BOQ_ROAD = [
  { description: 'Earthwork in excavation for roadway', unit: 'cum', quantity: 1200, rate: 185 },
  { description: 'Granular sub-base, Grade II', unit: 'cum', quantity: 860, rate: 1740 },
  { description: 'Bituminous macadam, 50 mm', unit: 'sqm', quantity: 42000, rate: 310 },
];

const tenderA = createPackage(db, {
  role: 'JE', actorUser: actorId(ACCOUNT.JE),
  title: 'Resurfacing of Dholka–Bagodara road, km 0 to km 11',
  department: 'Public Works Department (Roads)',
  scope: 'Profile correction and 50 mm bituminous macadam over 11 km of existing carriageway.',
  boq: BOQ_ROAD,
  estimated_cost: 41_800_000, completion_days: 180, emd_amount: 836_000,
  eligibility: 'Class I(A); one similar work of 40% value in the last five years',
  aa_reference: 'AA/RB/2026/204',
  site_lat: 22.7286, site_lng: 72.4694,
}).tender;
actOnTender(db, { tenderId: tenderA.id, role: 'JE', actorUser: actorId(ACCOUNT.JE), action: 'submit_package' });

const tenderB = createPackage(db, {
  role: 'AE', actorUser: actorId(ACCOUNT.AE),
  title: 'Construction of RCC overhead tank, 500 kl, Viramgam',
  department: 'Water Resources',
  scope: 'RCC overhead service reservoir of 500 kl capacity on a 16 m staging.',
  boq: [
    { description: 'RCC M-30 in staging and container', unit: 'cum', quantity: 340, rate: 7450 },
    { description: 'HYSD reinforcement, Fe 500D', unit: 'MT', quantity: 46, rate: 68000 },
  ],
  estimated_cost: 18_200_000, completion_days: 300, emd_amount: 364_000,
  eligibility: 'Class II and above with RCC water-retaining structure experience',
  aa_reference: 'AA/WR/2026/077',
  site_lat: 23.1200, site_lng: 72.0400,
}).tender;
actOnTender(db, { tenderId: tenderB.id, role: 'AE', actorUser: actorId(ACCOUNT.AE), action: 'submit_package' });
actOnTender(db, { tenderId: tenderB.id, role: 'DEE', actorUser: actorId(ACCOUNT.DEE), action: 'scrutinise',
                  comment: 'Quantities check against the drawings; sub-divisional technical approval accorded' });

const tenderC = createPackage(db, {
  role: 'JE', actorUser: actorId(ACCOUNT.JE),
  title: 'Strengthening of approach road to Kadi APMC',
  department: 'Public Works Department (Roads)',
  scope: 'Strengthening of 3.2 km approach road including cross drainage.',
  boq: [{ description: 'Wet mix macadam', unit: 'cum', quantity: 520, rate: 2080 }],
  estimated_cost: 9_400_000, completion_days: 120, emd_amount: 188_000,
  eligibility: 'Class II and above',
  aa_reference: 'AA/RB/2026/151',
  site_lat: 23.2960, site_lng: 72.3340,
}).tender;
actOnTender(db, { tenderId: tenderC.id, role: 'JE', actorUser: actorId(ACCOUNT.JE), action: 'submit_package' });
actOnTender(db, { tenderId: tenderC.id, role: 'DEE', actorUser: actorId(ACCOUNT.DEE), action: 'scrutinise' });
actOnTender(db, { tenderId: tenderC.id, role: 'EE', actorUser: actorId(ACCOUNT.EE), action: 'accord_ts',
                  budget_head: 'BE-2026-88', comment: 'Rates verified against the current SOR' });
actOnTender(db, {
  tenderId: tenderC.id, role: 'EE', actorUser: actorId(ACCOUNT.EE), action: 'publish_itt',
  dsc_pin: DSC_PIN, bid_due_date: new Date(Date.now() + 18 * 86_400_000).toISOString(),
  comment: 'ITT published on the departmental portal',
});

const counts = db.prepare(`SELECT
  (SELECT COUNT(*) FROM projects) AS projects,
  (SELECT COUNT(*) FROM approvals) AS approvals,
  (SELECT COUNT(*) FROM measurements) AS measurements,
  (SELECT COUNT(*) FROM delay_logs) AS delays,
  (SELECT COUNT(*) FROM tenders) AS tenders`).get();

console.log(`\n  Seeded ${counts.projects} projects, ${counts.approvals} approvals, ` +
            `${counts.measurements} e-MB entries, ${counts.delays} site-delay records, ` +
            `${counts.tenders} tenders.\n`);
console.log(`    PWD/2026/001  PENDING_AE        23 days  <- past SLA, but held: land + utilities`);
console.log(`    PWD/2026/002  PENDING_DEE    9 days  <- was rejected by the AE, then fixed`);
console.log(`    PWD/2026/003  PENDING_DEE   11 days  <- past SLA, held on the department's own funds`);
console.log(`    PWD/2026/004  PENDING_EE         2 days  <- click this through live`);
console.log(`    PWD/2026/005  PAYMENT_TRIGGERED  1 day   <- full chain, start to finish\n`);
console.log(`    NIT/${new Date().getFullYear()}/001  PENDING_DEE      <- waiting on DEE scrutiny`);
console.log(`    NIT/${new Date().getFullYear()}/002  PENDING_TS       <- waiting on EE technical sanction`);
console.log(`    NIT/${new Date().getFullYear()}/003  PUBLISHED        <- ITT live; record the work order to open a project\n`);
console.log(`  Now run:  npm start   then open http://localhost:3000\n`);
