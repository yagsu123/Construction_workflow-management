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
import { schemaState } from './db.js';

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
    actor_user: row.actor_user ?? '',
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
    actor_user: row.actor_user ?? '',
    // The verification verdict is part of what is signed. An entry cannot be quietly
    // upgraded from UNVERIFIED to EXIF_CONFIRMED after the fact.
    exif_lat: row.exif_lat ?? null,
    exif_lng: row.exif_lng ?? null,
    exif_taken_at: row.exif_taken_at ?? null,
    photo_verified: row.photo_verified ?? 'UNVERIFIED',
    distance_m: row.distance_m ?? null,
    timestamp: row.timestamp,
  };
}

/** The fields of a delay log that the hash commits to. */
export function delayLogPayload(row) {
  return {
    type: 'DELAY_LOG',
    seq: Number(row.seq),
    project_id: Number(row.project_id),
    reported_by_role: row.reported_by_role,
    delay_category: row.delay_category,
    delay_responsibility: row.delay_responsibility,
    start_date: row.start_date,
    estimated_end_date: row.estimated_end_date ?? null,
    actual_end_date: row.actual_end_date ?? null,
    impact_days: Number(row.impact_days),
    description: row.description ?? '',
    evidence_document_url: row.evidence_document_url ?? null,
    status: row.status,
    actor_user: row.actor_user ?? '',
    timestamp: row.timestamp,
  };
}

/** The fields of an EOT approval that the hash commits to. */
export function eotApprovalPayload(row) {
  return {
    type: 'EOT_APPROVAL',
    seq: Number(row.seq),
    project_id: Number(row.project_id),
    delay_log_id: row.delay_log_id,
    requested_days: Number(row.requested_days),
    recommended_days_by_ae: row.recommended_days_by_ae ?? null,
    approved_days_by_ee: row.approved_days_by_ee ?? null,
    status: row.status,
    rejection_reason: row.rejection_reason ?? null,
    actor_role: row.actor_role,
    actor_user: row.actor_user ?? '',
    ledger_block_hash: row.ledger_block_hash ?? '',
    timestamp: row.timestamp,
  };
}

/**
 * The fields of a tender event that the hash commits to.
 *
 * `package_sha256` is the load-bearing one: it seals the scope, the BOQ and the estimate that
 * bidders were shown. Revise the package after publication and the fingerprint no longer matches
 * what the chain recorded.
 */
export function tenderEventPayload(row) {
  return {
    type: 'TENDER_EVENT',
    seq: Number(row.seq),
    tender_id: row.tender_id,
    event: row.event,
    status: row.status,
    actor_role: row.actor_role,
    actor_user: row.actor_user ?? '',
    comment: row.comment ?? '',
    package_sha256: row.package_sha256 ?? '',
    estimated_cost: row.estimated_cost === null || row.estimated_cost === undefined ? null : Number(row.estimated_cost),
    timestamp: row.timestamp,
  };
}

const PAYLOADS = {
  APPROVAL: approvalPayload,
  TENDER_EVENT: tenderEventPayload,
  MEASUREMENT: measurementPayload,
  DELAY_LOG: delayLogPayload,
  EOT_APPROVAL: eotApprovalPayload,
};

export function payloadFor(entryType, row) {
  return (PAYLOADS[entryType] ?? approvalPayload)(row);
}

/** Hash of the highest-seq entry across both tables, or the genesis hash if the chain is empty. */
export function tipHash(db) {
  // Every table that appends to the chain must appear here. Miss one and the next entry links
  // to the wrong predecessor, which shows up as BROKEN_LINK far away from the real mistake.
  const row = db.prepare(`
    SELECT hash FROM (
      SELECT seq, hash FROM approvals
      UNION ALL
      SELECT seq, hash FROM measurements
      UNION ALL
      SELECT seq, hash FROM delay_logs
      UNION ALL
      SELECT seq, hash FROM eot_requests
      UNION ALL
      SELECT seq, hash FROM tender_events
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
  if (!PAYLOADS[entryType]) throw new Error(`Unknown ledger entry type: ${entryType}`);

  const seq = nextSeq(db);
  const prev_hash = tipHash(db);
  const timestamp = data.timestamp ?? new Date().toISOString();

  const row = { ...data, seq, timestamp };
  const payload = payloadFor(entryType, row);
  const hash = computeHash(payload, prev_hash);

  let id;
  if (entryType === 'APPROVAL') {
    id = db.prepare(`
      INSERT INTO approvals (seq, project_id, stage, actor_role, actor_user, status, comment, timestamp, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(seq, row.project_id, row.stage, row.actor_role, row.actor_user ?? '', row.status,
           row.comment ?? '', timestamp, prev_hash, hash).lastInsertRowid;
  } else if (entryType === 'TENDER_EVENT') {
    id = db.prepare(`
      INSERT INTO tender_events (seq, tender_id, event, status, actor_role, actor_user, comment,
                                 package_sha256, estimated_cost, timestamp, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(seq, row.tender_id, row.event, row.status, row.actor_role, row.actor_user ?? '',
           row.comment ?? '', row.package_sha256 ?? '',
           row.estimated_cost ?? null, timestamp, prev_hash, hash).lastInsertRowid;
  } else if (entryType === 'DELAY_LOG') {
    id = db.prepare(`
      INSERT INTO delay_logs (id, seq, project_id, reported_by_role, delay_category, delay_responsibility,
                              start_date, estimated_end_date, actual_end_date, impact_days, description,
                              evidence_document_url, status, actor_user,
                              timestamp, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, seq, row.project_id, row.reported_by_role, row.delay_category, row.delay_responsibility,
           row.start_date, row.estimated_end_date ?? null, row.actual_end_date ?? null, row.impact_days, row.description ?? '',
           row.evidence_document_url ?? null, row.status, row.actor_user ?? '',
           timestamp, prev_hash, hash).lastInsertRowid;
  } else if (entryType === 'EOT_APPROVAL') {
    id = db.prepare(`
      INSERT INTO eot_requests (id, seq, project_id, delay_log_id, requested_days, recommended_days_by_ae,
                                approved_days_by_ee, status, rejection_reason, actor_role, actor_user,
                                ledger_block_hash, timestamp, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, seq, row.project_id, row.delay_log_id, row.requested_days, row.recommended_days_by_ae ?? null,
           row.approved_days_by_ee ?? null, row.status, row.rejection_reason ?? null, row.actor_role, row.actor_user ?? '',
           hash, timestamp, prev_hash, hash).lastInsertRowid;
    // note: ledger_block_hash stores the hash itself as requested.
  } else {
    id = db.prepare(`
      INSERT INTO measurements (seq, project_id, photo_url, photo_sha256, lat, lng, note,
                                actor_role, actor_user, exif_lat, exif_lng, exif_taken_at,
                                photo_verified, distance_m, timestamp, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(seq, row.project_id, row.photo_url, row.photo_sha256 ?? '', row.lat, row.lng,
           row.note ?? '', row.actor_role ?? 'JE', row.actor_user ?? '',
           row.exif_lat ?? null, row.exif_lng ?? null, row.exif_taken_at ?? null,
           row.photo_verified ?? 'UNVERIFIED', row.distance_m ?? null,
           timestamp, prev_hash, hash).lastInsertRowid;
  }

  if (anchorSink) anchorSink(seq, hash);

  return { id: Number(id), seq, prev_hash, hash, payload };
}

// Set by the app at startup. Kept as an injected sink so the ledger stays pure and the
// unit tests can run without touching the filesystem.
let anchorSink = null;
export function setAnchorSink(fn) { anchorSink = fn; }

/** Every entry of the unified chain, oldest first. */
export function readChain(db) {
  // One ordered chain over three entry types. Every branch must project the same columns in the
  // same order, so each table's own fields are NULL in the others' slots.
  return db.prepare(`
    SELECT 'APPROVAL' AS entry_type, id, seq, project_id, timestamp, prev_hash, hash,
           actor_role, actor_user,
           stage, status, comment,
           NULL AS photo_url, NULL AS photo_sha256, NULL AS lat, NULL AS lng, NULL AS note,
           NULL AS exif_lat, NULL AS exif_lng, NULL AS exif_taken_at,
           NULL AS photo_verified, NULL AS distance_m,
           NULL AS delay_category, NULL AS delay_responsibility, NULL AS start_date, NULL AS actual_end_date, NULL AS impact_days,
           NULL AS delay_log_id, NULL AS requested_days, NULL AS approved_days_by_ee,
           NULL AS tender_id, NULL AS event, NULL AS package_sha256, NULL AS estimated_cost,
           NULL AS reported_by_role, NULL AS estimated_end_date, NULL AS evidence_document_url,
           NULL AS description, NULL AS ledger_block_hash, NULL AS rejection_reason
      FROM approvals
    UNION ALL
    SELECT 'MEASUREMENT', id, seq, project_id, timestamp, prev_hash, hash,
           actor_role, actor_user,
           NULL, NULL, NULL,
           photo_url, photo_sha256, lat, lng, note,
           exif_lat, exif_lng, exif_taken_at,
           photo_verified, distance_m,
           NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL,
           NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL, NULL
      FROM measurements
    UNION ALL
    SELECT 'DELAY_LOG', 0 AS id, seq, project_id, timestamp, prev_hash, hash,
           reported_by_role AS actor_role, actor_user,
           NULL, status, description AS comment,
           NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL,
           NULL, NULL,
           delay_category, delay_responsibility, start_date, actual_end_date, impact_days,
           NULL, NULL, NULL,
           NULL, NULL, NULL, NULL,
           reported_by_role, estimated_end_date, evidence_document_url,
           description, NULL, NULL
      FROM delay_logs
    UNION ALL
    SELECT 'EOT_APPROVAL', 0 AS id, seq, project_id, timestamp, prev_hash, hash,
           actor_role, actor_user,
           NULL, status, rejection_reason AS comment,
           NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL,
           NULL, NULL,
           NULL, NULL, NULL, NULL, NULL,
           delay_log_id, requested_days, approved_days_by_ee,
           NULL, NULL, NULL, NULL,
           NULL, NULL, NULL,
           NULL, ledger_block_hash, rejection_reason
      FROM eot_requests
    UNION ALL
    SELECT 'TENDER_EVENT', id, seq, NULL AS project_id, timestamp, prev_hash, hash,
           actor_role, actor_user,
           NULL, status, comment,
           NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL,
           NULL, NULL,
           NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL,
           tender_id, event, package_sha256, estimated_cost,
           NULL, NULL, NULL, NULL, NULL, NULL
      FROM tender_events
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

  // Entries written under an older payload shape cannot recompute under the new one. That is a
  // migration, not an attack, and saying "CHAIN BROKEN" would be a lie.
  const schema = schemaState(db);
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

  if (schema.stale && breaks.length) {
    return {
      valid: false, stale_schema: true, schema,
      length: entries.length,
      tip: entries.length ? entries[entries.length - 1].hash : GENESIS_HASH,
      first_break: null,
      entries: checked,
      breaks: [],
      note: `This ledger was written under payload schema v${schema.version}; the code now uses ` +
            `v${schema.current}. These entries cannot recompute and this is NOT evidence of ` +
            `tampering. Run \`npm run seed\` to rebuild the chain.`,
    };
  }

  return {
    valid: breaks.length === 0,
    stale_schema: false,
    schema,
    length: entries.length,
    tip: entries.length ? entries[entries.length - 1].hash : GENESIS_HASH,
    first_break: breaks.length ? breaks[0].seq : null,
    entries: checked,
    breaks,
  };
}
