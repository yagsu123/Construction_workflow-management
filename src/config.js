import os from 'node:os';
import path from 'node:path';

// Domain constants shared by the server, the seeder and the UI.
// Locked in Phase 0 — see DECISIONS.md.

export const GENESIS_HASH = '0'.repeat(64);

export const ROLES = {
  CONTRACTOR: { id: 'CONTRACTOR', label: 'Primary Contractor', short: 'CONTRACTOR',
                duty: 'Submits RA Bills for payment' },
  JE:  { id: 'JE',  label: 'Junior Engineer',              short: 'JE',
         duty: 'Records geo-tagged e-MB entries from site' },
  AE:  { id: 'AE',  label: 'Assistant Engineer / SDO',     short: 'AE',
         duty: 'Test-checks the JE\'s physical measurements' },
  DEE: { id: 'DEE', label: 'Deputy Executive Engineer',     short: 'DEE',
         duty: 'Conducts the physical test-check (30% of the work) and accords sub-divisional technical approval' },
  EE:  { id: 'EE',  label: 'Executive Engineer',           short: 'EE',
         duty: 'Grants final approval and triggers the smart contract' },
};

export const ROLE_IDS = Object.keys(ROLES);

// Linear stage machine. `actor` is the role that must act to move the project on.
export const STAGES = {
  DRAFT:             { id: 'DRAFT',             label: 'RA Bill Prep',         actor: 'CONTRACTOR', next: 'PENDING_JE' },
  PENDING_JE:        { id: 'PENDING_JE',        label: 'e-MB Recording',       actor: 'JE',  next: 'PENDING_AE' },
  PENDING_AE:        { id: 'PENDING_AE',        label: 'AE Test-Check',        actor: 'AE',  next: 'PENDING_DEE' },
  PENDING_DEE:   { id: 'PENDING_DEE',   label: 'DEE Technical Approval',      actor: 'DEE', next: 'PENDING_EE' },
  PENDING_EE:        { id: 'PENDING_EE',        label: 'EE Final Approval',    actor: 'EE',  next: 'APPROVED' },
  APPROVED:          { id: 'APPROVED',          label: 'Approved',             actor: null,  next: 'PAYMENT_TRIGGERED' },
  PAYMENT_TRIGGERED: { id: 'PAYMENT_TRIGGERED', label: 'Payment Triggered',    actor: null,  next: null },
};

export const STAGE_ORDER = ['DRAFT', 'PENDING_JE', 'PENDING_AE', 'PENDING_DEE', 'PENDING_EE', 'APPROVED', 'PAYMENT_TRIGGERED'];

// The DSC PIN that stands in for a real digital signature token. Demo-scale on purpose: the
// point is that publication and final approval are SIGNED acts, not that this is a real HSM.
export const DSC_PIN = process.env.DSC_PIN || '1234';

// --- tender initiation --------------------------------------------------------------------------
// Upstream of everything else: a work package is defined, scrutinised, sanctioned and authorised
// before an Invitation to Tender is published. Bidding and evaluation are out of scope; the flow
// resumes at the work order, which creates the project at DRAFT.
export const TENDER_STAGES = {
  PACKAGE_DRAFT:   { id: 'PACKAGE_DRAFT',   label: 'Package preparation',        actor: 'JE'  },
  PENDING_DEE:     { id: 'PENDING_DEE',     label: 'DEE scrutiny',               actor: 'DEE' },
  PENDING_TS:      { id: 'PENDING_TS',      label: 'Technical Sanction',         actor: 'EE'  },
  PENDING_PUBLISH: { id: 'PENDING_PUBLISH', label: 'Authorisation to publish',   actor: 'EE'  },
  PUBLISHED:       { id: 'PUBLISHED',       label: 'ITT published',              actor: 'EE'  },
  PARKED:          { id: 'PARKED',          label: 'Parked — no budget',         actor: 'EE'  },
  AWARDED:         { id: 'AWARDED',         label: 'Awarded — work order issued', actor: null },
};

export const TENDER_STAGE_ORDER = ['PACKAGE_DRAFT', 'PENDING_DEE', 'PENDING_TS', 'PENDING_PUBLISH', 'PUBLISHED', 'AWARDED'];

/**
 * `event` is what goes on the ledger; `to` is the status the tender lands in.
 * The estimate is written by the JE or AE and sanctioned by the EE — deliberately different
 * people, because an officer who writes an estimate and then sanctions it has sanctioned nothing.
 */
export const TENDER_TRANSITIONS = {
  PACKAGE_DRAFT: {
    JE: [{ action: 'submit_package', label: 'Submit for DEE scrutiny', event: 'SUBMITTED_FOR_SCRUTINY', to: 'PENDING_DEE', tone: 'primary' }],
    AE: [{ action: 'submit_package', label: 'Submit for DEE scrutiny', event: 'SUBMITTED_FOR_SCRUTINY', to: 'PENDING_DEE', tone: 'primary' }],
  },
  PENDING_DEE: {
    DEE: [
      { action: 'scrutinise', label: 'Accord sub-divisional technical approval', event: 'SUB_DIVISIONAL_APPROVAL', to: 'PENDING_TS', tone: 'primary' },
      { action: 'return', label: 'Return for revision', event: 'RETURNED_BY_DEE', to: 'PACKAGE_DRAFT', tone: 'danger', needsComment: true },
    ],
  },
  PENDING_TS: {
    EE: [
      { action: 'accord_ts', label: 'Accord Technical Sanction', event: 'TECHNICAL_SANCTION', to: 'PENDING_PUBLISH', tone: 'primary' },
      { action: 'park', label: 'Park — budget not available', event: 'PARKED_NO_BUDGET', to: 'PARKED', tone: 'danger', needsComment: true },
      { action: 'return', label: 'Return for revision', event: 'RETURNED_BY_EE', to: 'PACKAGE_DRAFT', tone: 'danger', needsComment: true },
    ],
  },
  PENDING_PUBLISH: {
    EE: [
      { action: 'publish_itt', label: 'Publish ITT (requires DSC PIN)', event: 'ITT_PUBLISHED', to: 'PUBLISHED', tone: 'primary' },
      { action: 'return', label: 'Withdraw for revision', event: 'RETURNED_BY_EE', to: 'PACKAGE_DRAFT', tone: 'danger', needsComment: true },
    ],
  },
  PUBLISHED: {
    EE: [{ action: 'award', label: 'Record work order', event: 'WORK_ORDER_ISSUED', to: 'AWARDED', tone: 'primary' }],
  },
  PARKED: {
    EE: [{ action: 'revive', label: 'Budget released — revive', event: 'REVIVED', to: 'PENDING_TS', tone: 'primary' }],
  },
  AWARDED: {},
};

// A project sitting in one stage longer than this is flagged red on the delay dashboard.
export const SLA_DAYS = 7;

// --- geofencing -------------------------------------------------------------------------------
// An e-MB entry must be recorded within this distance of the project's registered site. Without
// it, "geo-tagged" means only that the browser sent two numbers - which it will happily do from
// anywhere. 250 m covers a road package's working front while still excluding the next town.
export const DEFAULT_SITE_RADIUS_M = Number(process.env.SITE_RADIUS_M || 250);

// How far the photo's own EXIF GPS may sit from the browser's reported fix before we call it a
// contradiction. Consumer GPS drifts; 200 m is generous without being meaningless.
export const EXIF_DRIFT_M = Number(process.env.EXIF_DRIFT_M || 200);

// How stale a photo may be when it is submitted. Catches re-uploading last month's picture.
export const EXIF_MAX_AGE_HOURS = Number(process.env.EXIF_MAX_AGE_HOURS || 24);

// 'warn'   — a photo with no EXIF is accepted but permanently recorded as UNVERIFIED
// 'strict' — no EXIF GPS, no entry
// A photo whose EXIF CONTRADICTS the claim is rejected under both: absence is not evidence,
// but contradiction is.
export const EXIF_POLICY = process.env.EXIF_POLICY === 'strict' ? 'strict' : 'warn';

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
