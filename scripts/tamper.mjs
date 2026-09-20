#!/usr/bin/env node
// The tamper demo. Three attacks, one command each, so nothing is typed on stage.
//
//   npm run tamper              list the attacks
//   npm run tamper edit         alter a record  -> chain breaks at that row
//   npm run tamper resign       alter it AND recompute every hash -> chain looks perfect,
//                               anchors catch it
//   npm run tamper photo        swap the site photo on disk -> row intact, photo flagged
//   npm run tamper restore      reseed and start over
//
// Each attack writes DIRECTLY to the database, behind the application's back - which is the
// whole point. No API, no session, no login.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDb } from '../src/db.js';
import { verifyChain, computeHash, approvalPayload, payloadFor, readChain } from '../src/ledger.js';
import { checkAnchors } from '../src/anchor.js';
import { UPLOAD_DIR } from '../src/uploads.js';
import { GENESIS_HASH } from '../src/config.js';

const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';
const short = h => `${String(h).slice(0, 10)}…${String(h).slice(-6)}`;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const db = getDb();
const mode = (process.argv[2] || '').toLowerCase();

function state(label) {
  const chain = verifyChain(db);
  const anchors = checkAnchors(db);
  console.log(`  ${B}${label}${X}`);
  console.log(`    chain   ${chain.valid ? `${G}valid${X}` : `${R}BROKEN at seq ${chain.first_break}${X}`}   ${D}${chain.length} entries, tip ${short(chain.tip)}${X}`);
  console.log(`    anchors ${anchors.valid ? `${G}match${X}` : `${R}MISMATCH${X}`}   ${D}${anchors.checked} published${X}`);
  return { chain, anchors };
}

function reseed() {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', path.join(ROOT, 'scripts', 'seed.mjs')],
    { cwd: ROOT, stdio: 'ignore' });
  if (r.status !== 0) { console.log(`\n  ${R}Reseed failed.${X} Run \`npm run seed\` yourself.\n`); process.exit(1); }
}

function pickVerified() {
  const row = db.prepare(`SELECT * FROM approvals WHERE status = 'TECH_APPROVED' ORDER BY seq LIMIT 1`).get();
  if (!row) { console.log(`\n  ${Y}No DEE technical approval in the ledger. Run \`npm run seed\` first.${X}\n`); process.exit(1); }
  return row;
}

// ---------------------------------------------------------------------------------------------

if (!mode || mode === 'help' || mode === '--help') {
  console.log(`
  ${B}Tamper demo${X}  ${D}— each attack edits the database directly, bypassing the application${X}

    ${B}npm run tamper edit${X}      Change a verified amount.
                            ${D}The chain breaks at that row and names it.${X}

    ${B}npm run tamper resign${X}    Change it, then recompute every hash so the chain is
                            internally perfect again.
                            ${D}The chain cannot see this. The anchors can.${X}

    ${B}npm run tamper photo${X}     Swap the site photo file on disk.
                            ${D}The ledger row is untouched; the photo is flagged.${X}

    ${B}npm run tamper restore${X}   Reseed and start over.
`);
  process.exit(0);
}

if (mode === 'restore') {
  reseed();
  console.log(`\n  ${G}Restored.${X} Fresh seed, fresh anchors.\n`);
  state('now');
  console.log();
  process.exit(0);
}

console.log();
state('before');
console.log();

// --- attack 1: edit one record ---------------------------------------------------------------
if (mode === 'edit') {
  const row = pickVerified();
  const forged = 'Budget head BE-2026-41 confirmed — revised to Rs 2,45,00,000';
  console.log(`  ${Y}Editing approval seq ${row.seq} directly in SQLite${X}`);
  console.log(`    ${D}was:${X} ${row.comment}`);
  console.log(`    ${D}now:${X} ${forged}\n`);
  db.prepare('UPDATE approvals SET comment = ? WHERE seq = ?').run(forged, row.seq);

  const { chain } = state('after');
  console.log();
  if (chain.valid) { console.log(`  ${R}The tamper was NOT detected. That is a bug.${X}\n`); process.exit(1); }

  const b = chain.breaks[0];
  console.log(`  ${R}Caught.${X} Entry ${b.seq} no longer hashes to its stored value.`);
  console.log(`    ${D}stored     ${short(chain.entries.find(e => e.seq === b.seq).hash)}${X}`);
  console.log(`    ${D}recomputed ${short(b.recomputed)}${X}`);
  console.log(`\n  ${D}Say: "One row changed in the database. Nobody touched the application.`);
  console.log(`  The ledger caught it and named the exact record."${X}\n`);
  console.log(`  ${D}Next: npm run tamper restore${X}\n`);
}

// --- attack 2: edit AND re-sign ----------------------------------------------------------------
else if (mode === 'resign') {
  const row = pickVerified();
  const forged = 'Budget head BE-2026-41 confirmed — revised to Rs 2,45,00,000';
  console.log(`  ${Y}Editing approval seq ${row.seq}, then recomputing every hash from genesis${X}`);
  console.log(`    ${D}This is what a competent attacker with database access would do.${X}\n`);

  db.prepare('UPDATE approvals SET comment = ? WHERE seq = ?').run(forged, row.seq);

  let prev = GENESIS_HASH;
  for (const e of readChain(db)) {
    const hash = computeHash(payloadFor(e.entry_type, e), prev);
    const table = e.entry_type === 'APPROVAL' ? 'approvals' : 'measurements';
    db.prepare(`UPDATE ${table} SET prev_hash = ?, hash = ? WHERE seq = ?`).run(prev, hash, e.seq);
    prev = hash;
  }

  const { chain, anchors } = state('after');
  console.log();
  if (chain.valid) {
    console.log(`  ${Y}The chain says VALID${X} — and it is right. Every hash recomputes.`);
    console.log(`  ${D}A hash chain proves internal consistency, not history.${X}\n`);
  }
  if (anchors.valid) { console.log(`  ${R}The anchors did NOT catch it. That is a bug.${X}\n`); process.exit(1); }

  const m = anchors.mismatches[0];
  console.log(`  ${R}Caught by the anchors.${X}`);
  console.log(`    at length ${m.length}:  published ${short(m.tip)}`);
  console.log(`                    chain now ${short(m.current ?? 'missing')}`);
  console.log(`\n  ${D}Say: "The chain alone can't see this — and neither could a real blockchain,`);
  console.log(`  if it only lived on the same server. That's why the tip is published outside`);
  console.log(`  the database after every entry. Rewriting history changes the tip."${X}\n`);
  console.log(`  ${D}Next: npm run tamper restore${X}\n`);
}

// --- attack 3: swap the photo -------------------------------------------------------------------
else if (mode === 'photo') {
  const m = db.prepare('SELECT * FROM measurements ORDER BY seq LIMIT 1').get();
  if (!m) { console.log(`\n  ${Y}No e-MB entries. Run \`npm run seed\` first.${X}\n`); process.exit(1); }

  const file = path.join(UPLOAD_DIR, path.basename(m.photo_url));
  console.log(`  ${Y}Replacing the site photo on disk for e-MB seq ${m.seq}${X}`);
  console.log(`    ${D}${m.photo_url} — the ledger row is not touched at all${X}\n`);

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">
    <rect width="240" height="240" fill="#2f6d3f"/>
    <text x="120" y="126" font-family="sans-serif" font-size="16" fill="#fff" text-anchor="middle">substituted photo</text>
  </svg>`);

  const { chain } = state('after');
  const entry = chain.entries.find(e => e.seq === m.seq);
  const onDisk = (await import('../src/uploads.js')).photoStillMatches(m.photo_url, m.photo_sha256);
  console.log();
  console.log(`  chain still ${chain.valid ? `${G}valid${X}` : `${R}broken${X}`} — correct, because the ${B}record${X} was not altered.`);
  if (onDisk.matches) { console.log(`\n  ${R}The photo swap was NOT detected. That is a bug.${X}\n`); process.exit(1); }
  console.log(`  photo       ${R}MISMATCH${X}`);
  console.log(`    ${D}signed   ${short(m.photo_sha256)}${X}`);
  console.log(`    ${D}on disk  ${short(onDisk.actual)}${X}`);
  console.log(`\n  ${D}Say: "The measurement record is untouched — but the photo it points at isn't`);
  console.log(`  the photo that was signed. The image's own hash is inside the ledger entry."${X}`);
  console.log(`\n  ${D}Open the Ledger page: that row now carries a "photo swapped" flag.${X}`);
  console.log(`  ${D}Next: npm run tamper restore${X}\n`);
}

else {
  console.log(`  ${R}Unknown attack "${mode}".${X} Try: edit · resign · photo · restore\n`);
  process.exit(1);
}
