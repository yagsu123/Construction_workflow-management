#!/usr/bin/env node
// Re-validate the entire ledger chain and print a human-readable report.
// Exits 1 if the chain is broken — usable as a CI / cron integrity check.

import { getDb } from '../src/db.js';
import { verifyChain } from '../src/ledger.js';

const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
const short = h => `${h.slice(0, 10)}…${h.slice(-6)}`;

const result = verifyChain(getDb());

console.log(`\n  Ledger integrity check — ${result.length} entr${result.length === 1 ? 'y' : 'ies'}\n`);

if (result.length === 0) {
  console.log(`  ${Y}Chain is empty.${X} Run \`npm run seed\` first.\n`);
  process.exit(0);
}

for (const e of result.entries) {
  const mark = e.ok ? `${G}ok${X}` : `${R}FAIL${X}`;
  const kind = e.entry_type === 'APPROVAL' ? `${e.status} by ${e.actor_role}` : `e-MB ${e.lat},${e.lng}`;
  console.log(`  ${String(e.seq).padStart(3)}  ${mark}  ${e.entry_type.padEnd(11)} project ${String(e.project_id).padEnd(3)} ${kind}`);
  console.log(`       ${D}prev ${short(e.prev_hash)}  ->  hash ${short(e.hash)}${X}`);
  if (!e.ok) {
    for (const r of e.reasons) {
      if (r === 'ALTERED_PAYLOAD') {
        console.log(`       ${R}ALTERED_PAYLOAD${X}  stored ${short(e.hash)} but this row now hashes to ${short(e.recomputed)}`);
      } else {
        console.log(`       ${R}BROKEN_LINK${X}      prev_hash does not match the previous entry's hash`);
      }
    }
  }
}

if (result.valid) {
  console.log(`\n  ${G}CHAIN VALID${X} — every hash recomputes. Tip ${short(result.tip)}\n`);
  process.exit(0);
}

console.log(`\n  ${R}CHAIN BROKEN${X} — first break at seq ${result.first_break}, ${result.breaks.length} entr${result.breaks.length === 1 ? 'y' : 'ies'} affected.`);
console.log(`  ${D}Every record from seq ${result.first_break} onward is no longer trustworthy.${X}\n`);
process.exit(1);
