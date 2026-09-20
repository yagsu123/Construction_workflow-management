// Hash-chained append-only ledger.
//
// Approvals and measurements share ONE chain, ordered by a monotonic `seq`, so a single
// audit trail covers both "who signed off" and "what was measured on site".
//
//     hash = SHA256( canonicalJson(payload) + prev_hash )
//
// The genesis entry's prev_hash is 64 zeroes. Because each hash commits to the previous one,
// editing any historical row invalidates that row and every row after it — which is exactly
// what verifyChain() reports.

import { createHash } from 'node:crypto';
import { GENESIS_HASH } from './config.js';

/**
 * Deterministic JSON: keys sorted recursively, so an identical payload always
 * serialises to an identical string regardless of insertion order.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** hash = SHA256(canonicalJson(payload) + prevHash) */
export function computeHash(payload, prevHash) {
  return createHash('sha256').update(canonicalJson(payload) + prevHash).digest('hex');
}

/** The fields of an approval row that the hash commits to. */
export function approvalPayload(row) {
  return {
    type: 'APPROVAL',
    seq: Number(row.seq),
    project_id: Number(row.project_id),
    stage: row.stage,
    actor_role: row.actor_role,
    status: row.status,
    comment: row.comment ?? '',
    timestamp: row.timestamp,
  };
}

/** The fields of a measurement row that the hash commits to. */
export function measurementPayload(row) {
  return {
    type: 'MEASUREMENT',
    seq: Number(row.seq),
    project_id: Number(row.project_id),
    photo_url: row.photo_url,
    photo_sha256: row.photo_sha256 ?? '',
    lat: Number(row.lat),
    lng: Number(row.lng),
    note: row.note ?? '',
    actor_role: row.actor_role ?? 'JE',
    timestamp: row.timestamp,
  };
}

export function payloadFor(entryType, row) {
  return entryType === 'APPROVAL' ? approvalPayload(row) : measurementPayload(row);
}

/** Hash of the highest-seq entry across both tables, or the genesis hash if the chain is empty. */
export function tipHash(db) {
  const row = db.prepare(`
    SELECT hash FROM (
      SELECT seq, hash FROM approvals
      UNION ALL
      SELECT seq, hash FROM measurements
    ) ORDER BY seq DESC LIMIT 1
  `).get();
  return row ? row.hash : GENESIS_HASH;
}

function nextSeq(db) {
  const { next } = db.prepare('SELECT next FROM ledger_seq WHERE id = 1').get();
  db.prepare('UPDATE ledger_seq SET next = ? WHERE id = 1').run(next + 1);
  return next;
}

/**
 * Append one entry to the unified chain and persist it.
 *
 * @param {DatabaseSync} db
 * @param {'APPROVAL'|'MEASUREMENT'} entryType
 * @param {object} data  domain fields, without seq / prev_hash / hash
 * @returns {{id:number, seq:number, prev_hash:string, hash:string, payload:object}}
 */
export function appendLedgerEntry(db, entryType, data) {
  if (entryType !== 'APPROVAL' && entryType !== 'MEASUREMENT') {
    throw new Error(`Unknown ledger entry type: ${entryType}`);
  }

  const seq = nextSeq(db);
  const prev_hash = tipHash(db);
  const timestamp = data.timestamp ?? new Date().toISOString();

  const row = { ...data, seq, timestamp };
  const payload = payloadFor(entryType, row);
  const hash = computeHash(payload, prev_hash);

  let id;
  if (entryType === 'APPROVAL') {
    id = db.prepare(`
      INSERT INTO approvals (seq, project_id, stage, actor_role, status, comment, timestamp, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(seq, row.project_id, row.stage, row.actor_role, row.status,
           row.comment ?? '', timestamp, prev_hash, hash).lastInsertRowid;
  } else {
    id = db.prepare(`
      INSERT INTO measurements (seq, project_id, photo_url, photo_sha256, lat, lng, note, actor_role, timestamp, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(seq, row.project_id, row.photo_url, row.photo_sha256 ?? '', row.lat, row.lng,
           row.note ?? '', row.actor_role ?? 'JE', timestamp, prev_hash, hash).lastInsertRowid;
  }

  return { id: Number(id), seq, prev_hash, hash, payload };
}

/** Every entry of the unified chain, oldest first. */
export function readChain(db) {
  return db.prepare(`
    SELECT 'APPROVAL' AS entry_type, id, seq, project_id, stage, actor_role, status, comment,
           NULL AS photo_url, NULL AS photo_sha256, NULL AS lat, NULL AS lng, NULL AS note,
           timestamp, prev_hash, hash
      FROM approvals
    UNION ALL
    SELECT 'MEASUREMENT' AS entry_type, id, seq, project_id, NULL, actor_role, NULL, NULL,
           photo_url, photo_sha256, lat, lng, note,
           timestamp, prev_hash, hash
      FROM measurements
    ORDER BY seq ASC
  `).all();
}

/**
 * Recompute the whole chain and report where (if anywhere) it stops matching.
 *
 * @returns {{valid:boolean, length:number, tip:string, entries:Array, breaks:Array}}
 */
export function verifyChain(db) {
  const entries = readChain(db);
  const breaks = [];
  let expectedPrev = GENESIS_HASH;

  const checked = entries.map(entry => {
    const reasons = [];
    if (entry.prev_hash !== expectedPrev) reasons.push('BROKEN_LINK');

    // Recompute against the prev_hash actually stored, so a tampered payload is
    // reported as ALTERED_PAYLOAD rather than being masked by the link error.
    const recomputed = computeHash(payloadFor(entry.entry_type, entry), entry.prev_hash);
    if (recomputed !== entry.hash) reasons.push('ALTERED_PAYLOAD');

    const ok = reasons.length === 0;
    if (!ok) breaks.push({ seq: entry.seq, entry_type: entry.entry_type, id: entry.id, reasons, expected_prev: expectedPrev, recomputed });

    expectedPrev = entry.hash;
    return { ...entry, ok, reasons, recomputed };
  });

  return {
    valid: breaks.length === 0,
    length: entries.length,
    tip: entries.length ? entries[entries.length - 1].hash : GENESIS_HASH,
    first_break: breaks.length ? breaks[0].seq : null,
    entries: checked,
    breaks,
  };
}
