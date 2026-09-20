import os from 'node:os';
import path from 'node:path';

// Domain constants shared by the server, the seeder and the UI.
// Locked in Phase 0 — see DECISIONS.md.

export const GENESIS_HASH = '0'.repeat(64);

export const ROLES = {
  JE:  { id: 'JE',  label: 'Junior Engineer',              short: 'JE',
         duty: 'Records geo-tagged e-MB entries from site' },
  AE:  { id: 'AE',  label: 'Assistant Engineer / SDO',     short: 'AE',
         duty: 'Test-checks the JE\'s physical measurements' },
  FIN: { id: 'FIN', label: 'Finance / Accounts',           short: 'FIN',
         duty: 'Verifies the claim against the sanctioned budget head' },
  EE:  { id: 'EE',  label: 'Executive Engineer',           short: 'EE',
         duty: 'Grants final approval and triggers the smart contract' },
};

export const ROLE_IDS = Object.keys(ROLES);

// Linear stage machine. `actor` is the role that must act to move the project on.
export const STAGES = {
  DRAFT:             { id: 'DRAFT',             label: 'Draft / With JE',      actor: 'JE',  next: 'PENDING_AE' },
  PENDING_AE:        { id: 'PENDING_AE',        label: 'AE Test-Check',        actor: 'AE',  next: 'PENDING_FINANCE' },
  PENDING_FINANCE:   { id: 'PENDING_FINANCE',   label: 'Finance Verification', actor: 'FIN', next: 'PENDING_EE' },
  PENDING_EE:        { id: 'PENDING_EE',        label: 'EE Final Approval',    actor: 'EE',  next: 'APPROVED' },
  APPROVED:          { id: 'APPROVED',          label: 'Approved',             actor: null,  next: 'PAYMENT_TRIGGERED' },
  PAYMENT_TRIGGERED: { id: 'PAYMENT_TRIGGERED', label: 'Payment Triggered',    actor: null,  next: null },
};

export const STAGE_ORDER = ['DRAFT', 'PENDING_AE', 'PENDING_FINANCE', 'PENDING_EE', 'APPROVED', 'PAYMENT_TRIGGERED'];

// A project sitting in one stage longer than this is flagged red on the delay dashboard.
export const SLA_DAYS = 7;

export const DEPARTMENTS = [
  'Public Works Department (Roads)',
  'Public Works Department (Buildings)',
  'Water Resources',
  'Urban Development',
  'Rural Development',
];

export const PORT = Number(process.env.PORT || 3000);

// The database deliberately lives OUTSIDE the repo, in the user's home directory.
//
// This repo sits in a OneDrive-synced folder. A live SQLite file in a synced folder is a real
// hazard: the sync client holds handles on the -wal/-shm side files (they are memory-mapped),
// which produced SQLITE_IOERR on open and left undeletable files behind; worse, a sync client
// copying a database mid-write can corrupt it outright. Keeping it in ~/.pwd-infra-workflow/
// sidesteps both, and the demo data is reproducible with `npm run seed` anyway.
//
// Override with DB_PATH=... to put it anywhere else.
export const DB_PATH = process.env.DB_PATH
  || path.join(os.homedir(), '.pwd-infra-workflow', 'app.db');

// The anchor log lives OUTSIDE the database on purpose — see src/anchor.js. Anchoring the
// chain tip somewhere the database cannot reach is what catches a fully re-signed chain.
export const ANCHOR_PATH = process.env.ANCHOR_PATH
  || path.join(path.dirname(DB_PATH), 'anchors.log');
