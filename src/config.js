// Domain constants shared by the server, the seeder and the UI.
// Locked in Phase 0 — see DECISIONS.md.

export const GENESIS_HASH = '0'.repeat(64);

export const ROLES = {
  JE:  { id: 'JE',  label: 'Junior Engineer',    short: 'JE'  },
  FIN: { id: 'FIN', label: 'Finance / Accounts', short: 'FIN' },
  EE:  { id: 'EE',  label: 'Executive Engineer', short: 'EE'  },
};

export const ROLE_IDS = Object.keys(ROLES);

// Linear stage machine. `actor` is the role that must act to move the project on.
export const STAGES = {
  DRAFT:             { id: 'DRAFT',             label: 'Draft / With JE',      actor: 'JE',  next: 'PENDING_FINANCE' },
  PENDING_FINANCE:   { id: 'PENDING_FINANCE',   label: 'Finance Verification', actor: 'FIN', next: 'PENDING_EE' },
  PENDING_EE:        { id: 'PENDING_EE',        label: 'EE Final Approval',    actor: 'EE',  next: 'APPROVED' },
  APPROVED:          { id: 'APPROVED',          label: 'Approved',             actor: null,  next: 'PAYMENT_TRIGGERED' },
  PAYMENT_TRIGGERED: { id: 'PAYMENT_TRIGGERED', label: 'Payment Triggered',    actor: null,  next: null },
};

export const STAGE_ORDER = ['DRAFT', 'PENDING_FINANCE', 'PENDING_EE', 'APPROVED', 'PAYMENT_TRIGGERED'];

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
export const DB_PATH = process.env.DB_PATH || './data/app.db';
