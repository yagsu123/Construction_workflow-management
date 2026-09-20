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
  current_stage    TEXT    NOT NULL DEFAULT 'DRAFT',
  stage_entered_at TEXT    NOT NULL,
  created_at       TEXT    NOT NULL
);

-- Shared monotonic counter, so approvals and measurements form ONE ordered chain.
CREATE TABLE IF NOT EXISTS ledger_seq (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  next INTEGER NOT NULL
);
INSERT OR IGNORE INTO ledger_seq (id, next) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS approvals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seq        INTEGER NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  stage      TEXT    NOT NULL,
  actor_role TEXT    NOT NULL,
  status     TEXT    NOT NULL,          -- SUBMITTED | VERIFIED | APPROVED | REJECTED | PAYMENT_TRIGGERED
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
  timestamp  TEXT    NOT NULL,
  prev_hash  TEXT    NOT NULL,
  hash       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_project    ON approvals(project_id);
CREATE INDEX IF NOT EXISTS idx_measurements_project ON measurements(project_id);
`;

export function openDb(dbPath = DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive migrations for databases created by an earlier phase.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(measurements)').all().map(c => c.name);
  if (!cols.includes('photo_sha256')) {
    db.exec(`ALTER TABLE measurements ADD COLUMN photo_sha256 TEXT NOT NULL DEFAULT ''`);
  }
}

let singleton = null;
export function getDb() {
  if (!singleton) singleton = openDb();
  return singleton;
}

export function resetDb(db) {
  db.exec(`DELETE FROM measurements; DELETE FROM approvals; DELETE FROM projects;
           UPDATE ledger_seq SET next = 1;
           DELETE FROM sqlite_sequence WHERE name IN ('projects','approvals','measurements');`);
}
