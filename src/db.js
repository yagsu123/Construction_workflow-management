// SQLite connection + schema. Uses Node's built-in node:sqlite — no npm install.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './config.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT    NOT NULL UNIQUE,
  title            TEXT    NOT NULL,
  budget           REAL    NOT NULL,
  department       TEXT    NOT NULL,
  contractor       TEXT,
  site_lat         REAL,
  site_lng         REAL,
  site_radius_m    INTEGER,
  current_stage    TEXT    NOT NULL DEFAULT 'DRAFT',
  stage_entered_at TEXT    NOT NULL,
  created_at       TEXT    NOT NULL
);

-- Shared monotonic counter, so approvals and measurements form ONE ordered chain.
CREATE TABLE IF NOT EXISTS ledger_seq (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  next INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO ledger_seq (id, next, schema_version) VALUES (1, 1, 1);

CREATE TABLE IF NOT EXISTS approvals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seq        INTEGER NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  stage      TEXT    NOT NULL,
  actor_role TEXT    NOT NULL,
  status     TEXT    NOT NULL,          -- SUBMITTED | TEST_CHECKED | TECH_APPROVED | APPROVED | REJECTED | PAYMENT_TRIGGERED
  actor_user TEXT    NOT NULL DEFAULT '',
  comment    TEXT    NOT NULL DEFAULT '',
  timestamp  TEXT    NOT NULL,
  prev_hash  TEXT    NOT NULL,
  hash       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS measurements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seq        INTEGER NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  photo_url  TEXT    NOT NULL,
  lat        REAL    NOT NULL,
  lng        REAL    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  actor_role TEXT    NOT NULL DEFAULT 'JE',
  photo_sha256 TEXT  NOT NULL DEFAULT '',
  actor_user TEXT    NOT NULL DEFAULT '',
  exif_lat   REAL,
  exif_lng   REAL,
  exif_taken_at TEXT,
  photo_verified TEXT NOT NULL DEFAULT 'UNVERIFIED',  -- EXIF_CONFIRMED | UNVERIFIED
  distance_m INTEGER,
  timestamp  TEXT    NOT NULL,
  prev_hash  TEXT    NOT NULL,
  hash       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS delay_logs (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  reported_by_role TEXT NOT NULL,
  delay_category TEXT NOT NULL,
  delay_responsibility TEXT NOT NULL,
  start_date TEXT NOT NULL,
  estimated_end_date TEXT,
  actual_end_date TEXT,
  impact_days INTEGER NOT NULL,
  description TEXT NOT NULL,
  evidence_document_url TEXT,
  status TEXT NOT NULL,
  actor_user TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eot_requests (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  delay_log_id TEXT NOT NULL REFERENCES delay_logs(id),
  requested_days INTEGER NOT NULL,
  recommended_days_by_ae INTEGER,
  approved_days_by_ee INTEGER,
  status TEXT NOT NULL,
  rejection_reason TEXT,
  actor_role TEXT NOT NULL,
  actor_user TEXT NOT NULL DEFAULT '',
  ledger_block_hash TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenders (
  id                  TEXT    PRIMARY KEY,
  code                TEXT    NOT NULL UNIQUE,
  title               TEXT    NOT NULL,
  department          TEXT    NOT NULL,
  scope               TEXT    NOT NULL DEFAULT '',
  boq_json            TEXT    NOT NULL DEFAULT '[]',
  estimated_cost      REAL    NOT NULL,
  completion_days     INTEGER NOT NULL,
  emd_amount          REAL    NOT NULL DEFAULT 0,
  eligibility         TEXT    NOT NULL DEFAULT '',
  ld_per_week_pct     REAL    NOT NULL DEFAULT 0.5,
  aa_reference        TEXT    NOT NULL DEFAULT '',
  -- SHA-256 of the canonical package. Frozen into the ledger at publication, so what bidders
  -- were shown cannot be revised afterwards without the chain saying so.
  package_sha256      TEXT    NOT NULL DEFAULT '',
  status              TEXT    NOT NULL DEFAULT 'PACKAGE_DRAFT',
  budget_head         TEXT,
  ts_by               TEXT,
  ts_at               TEXT,
  itt_published_at    TEXT,
  bid_due_date        TEXT,
  project_id          INTEGER REFERENCES projects(id),
  site_lat            REAL,
  site_lng            REAL,
  site_radius_m       INTEGER,
  created_at          TEXT    NOT NULL,
  stage_entered_at    TEXT    NOT NULL
);

-- Append-only, one row per ledger entry. The tenders table above holds current state; this holds
-- the history, and nothing here is ever updated.
CREATE TABLE IF NOT EXISTS tender_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  seq            INTEGER NOT NULL UNIQUE,
  tender_id      TEXT    NOT NULL REFERENCES tenders(id),
  event          TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  actor_role     TEXT    NOT NULL,
  actor_user     TEXT    NOT NULL DEFAULT '',
  comment        TEXT    NOT NULL DEFAULT '',
  package_sha256 TEXT    NOT NULL DEFAULT '',
  estimated_cost REAL,
  timestamp      TEXT    NOT NULL,
  prev_hash      TEXT    NOT NULL,
  hash           TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tender_events_tender ON tender_events(tender_id);
CREATE INDEX IF NOT EXISTS idx_delay_logs_project ON delay_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_delay_logs_status  ON delay_logs(status);
CREATE INDEX IF NOT EXISTS idx_eot_requests_project ON eot_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_approvals_project    ON approvals(project_id);
CREATE INDEX IF NOT EXISTS idx_measurements_project ON measurements(project_id);
`;

// Bump whenever a field is ADDED TO or REMOVED FROM a hashed ledger payload. Entries written
// under an older version hash differently under the new code - which is indistinguishable from
// tampering unless we record it. A false "chain broken" banner on stage would be worse than
// no banner at all.
export const LEDGER_SCHEMA_VERSION = 5;

export function openDb(dbPath = DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive migrations for databases created by an earlier phase.
function migrate(db) {
  const add = (table, col, decl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  };
  add('measurements', 'photo_sha256', `TEXT NOT NULL DEFAULT ''`);
  add('measurements', 'actor_user', `TEXT NOT NULL DEFAULT ''`);
  add('approvals', 'actor_user', `TEXT NOT NULL DEFAULT ''`);
  add('projects', 'site_lat', 'REAL');
  add('projects', 'site_lng', 'REAL');
  add('projects', 'site_radius_m', 'INTEGER');
  add('measurements', 'exif_lat', 'REAL');
  add('measurements', 'exif_lng', 'REAL');
  add('measurements', 'exif_taken_at', 'TEXT');
  add('measurements', 'photo_verified', `TEXT NOT NULL DEFAULT 'UNVERIFIED'`);
  add('measurements', 'distance_m', 'INTEGER');
  add('ledger_seq', 'schema_version', 'INTEGER NOT NULL DEFAULT 1');

  // An empty chain can simply adopt the current version. A chain with entries in it cannot -
  // those entries were hashed under the old payload shape and will never recompute.
  const row = db.prepare('SELECT next, schema_version FROM ledger_seq WHERE id = 1').get();
  if (row && row.next === 1) {
    db.prepare('UPDATE ledger_seq SET schema_version = ? WHERE id = 1').run(LEDGER_SCHEMA_VERSION);
  }
}

/** @returns {{version:number, current:number, stale:boolean}} */
export function schemaState(db) {
  const row = db.prepare('SELECT next, schema_version FROM ledger_seq WHERE id = 1').get();
  const version = row?.schema_version ?? 1;
  return {
    version,
    current: LEDGER_SCHEMA_VERSION,
    stale: version < LEDGER_SCHEMA_VERSION && (row?.next ?? 1) > 1,
  };
}

let singleton = null;
export function getDb() {
  if (!singleton) singleton = openDb();
  return singleton;
}

export function resetDb(db) {
  db.exec(`DELETE FROM tender_events; DELETE FROM tenders; DELETE FROM eot_requests; DELETE FROM delay_logs; DELETE FROM measurements; DELETE FROM approvals; DELETE FROM projects;
           UPDATE ledger_seq SET next = 1;
           DELETE FROM sqlite_sequence WHERE name IN ('projects','approvals','measurements');`);
}
