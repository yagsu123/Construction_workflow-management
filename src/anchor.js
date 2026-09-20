// Anchoring — the answer to "but if I can edit the database, can't I just recompute every hash?"
//
// Yes. A hash chain that lives entirely inside the database it protects can be re-signed by
// anyone who can write to that database: alter a row, recompute every hash from there on, and
// verification passes. The chain proves internal consistency, not history.
//
// What defeats that is publishing the chain's tip somewhere the attacker does not control.
// A real deployment writes the tip to a public blockchain. Here it is appended to a file
// outside the database — same idea, miniature scale. Re-signing the chain now changes the tip,
// and the tip no longer matches what was anchored at that length.

import fs from 'node:fs';
import path from 'node:path';
import { ANCHOR_PATH } from './config.js';
import { readChain, computeHash, payloadFor } from './ledger.js';
import { GENESIS_HASH } from './config.js';

/** Append `{time, length, tip}` as one JSON line. Append-only by convention and by API. */
export function writeAnchor(length, tip, anchorPath = ANCHOR_PATH) {
  fs.mkdirSync(path.dirname(anchorPath), { recursive: true });
  fs.appendFileSync(anchorPath, JSON.stringify({ time: new Date().toISOString(), length, tip }) + '\n');
}

export function readAnchors(anchorPath = ANCHOR_PATH) {
  if (!fs.existsSync(anchorPath)) return [];
  return fs.readFileSync(anchorPath, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Recompute the chain from genesis and compare its state at each anchored length against
 * what was anchored then. Catches a fully re-signed chain, which verifyChain() cannot.
 *
 * @returns {{checked:number, valid:boolean, mismatches:Array}}
 */
export function checkAnchors(db, anchorPath = ANCHOR_PATH) {
  const anchors = readAnchors(anchorPath);
  if (anchors.length === 0) return { checked: 0, valid: true, mismatches: [] };

  // Tip after each prefix of the CURRENT chain, recomputed from genesis.
  const entries = readChain(db);
  const tipAtLength = new Map();
  let prev = GENESIS_HASH;
  entries.forEach((e, i) => {
    prev = computeHash(payloadFor(e.entry_type, e), prev);
    tipAtLength.set(i + 1, prev);
  });

  const mismatches = [];
  for (const a of anchors) {
    const current = a.length === 0 ? GENESIS_HASH : tipAtLength.get(a.length);
    if (current === undefined) {
      mismatches.push({ ...a, reason: 'CHAIN_SHORTER_THAN_ANCHOR', current: null });
    } else if (current !== a.tip) {
      mismatches.push({ ...a, reason: 'TIP_MISMATCH', current });
    }
  }

  return { checked: anchors.length, valid: mismatches.length === 0, mismatches };
}
