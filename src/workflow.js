// Workflow rules: who may act, what each action does, and how a project moves between stages.
// Every action is written to the ledger — including rejections, which is the point.

import { appendLedgerEntry } from './ledger.js';
import { STAGES, STAGE_ORDER, SLA_DAYS } from './config.js';

/**
 * The actions available from each stage, keyed by the role allowed to take them.
 * `to` is the stage the project lands in; `status` is what goes on the ledger.
 */
export const TRANSITIONS = {
  DRAFT: {
    JE: [{ action: 'submit', label: 'Submit to Finance', status: 'SUBMITTED', to: 'PENDING_FINANCE', tone: 'primary' }],
  },
  PENDING_FINANCE: {
    FIN: [
      { action: 'verify', label: 'Verify budget', status: 'VERIFIED', to: 'PENDING_EE', tone: 'primary' },
      { action: 'reject', label: 'Flag discrepancy', status: 'REJECTED', to: 'DRAFT', tone: 'danger', needsComment: true },
    ],
  },
  PENDING_EE: {
    EE: [
      { action: 'approve', label: 'Grant final approval', status: 'APPROVED', to: 'APPROVED', tone: 'primary' },
      { action: 'reject', label: 'Reject', status: 'REJECTED', to: 'DRAFT', tone: 'danger', needsComment: true },
    ],
  },
  APPROVED: {
    EE: [{ action: 'trigger_payment', label: 'Execute smart contract', status: 'PAYMENT_TRIGGERED', to: 'PAYMENT_TRIGGERED', tone: 'primary' }],
  },
  PAYMENT_TRIGGERED: {},
};

export function actionsFor(stage, role) {
  return (TRANSITIONS[stage] || {})[role] || [];
}

/** Every action available at this stage, whatever the role — used to explain "waiting on X". */
export function waitingOn(stage) {
  return STAGES[stage]?.actor ?? null;
}

export class WorkflowError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function createProject(db, { title, budget, department, contractor = '' }) {
  if (!title || !String(title).trim()) throw new WorkflowError('Title is required');
  const amount = Number(budget);
  if (!Number.isFinite(amount) || amount <= 0) throw new WorkflowError('Budget must be a positive number');
  if (!department) throw new WorkflowError('Department is required');

  const now = new Date().toISOString();
  const n = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c + 1;
  const code = `PWD/${new Date().getFullYear()}/${String(n).padStart(3, '0')}`;

  const id = db.prepare(`
    INSERT INTO projects (code, title, budget, department, contractor, current_stage, stage_entered_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?)
  `).run(code, String(title).trim(), amount, department, contractor, now, now).lastInsertRowid;

  return getProject(db, Number(id));
}

export function getProject(db, id) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) throw new WorkflowError('Project not found', 404);
  return project;
}

/**
 * Take an action on a project as a role. Validates the transition, appends to the
 * ledger, and moves the project's stage. Throws WorkflowError on an illegal move.
 */
export function act(db, { projectId, role, action, comment = '' }) {
  const project = getProject(db, projectId);
  const available = actionsFor(project.current_stage, role);
  const t = available.find(a => a.action === action);

  if (!t) {
    const actor = waitingOn(project.current_stage);
    throw new WorkflowError(
      actor
        ? `${role} cannot "${action}" a project at stage ${project.current_stage} — it is with ${actor}.`
        : `Project is at ${project.current_stage}; no further action is available.`
    );
  }
  if (t.needsComment && !String(comment).trim()) {
    throw new WorkflowError('A reason is required when sending a project back.');
  }

  const entry = appendLedgerEntry(db, 'APPROVAL', {
    project_id: project.id,
    stage: project.current_stage,
    actor_role: role,
    status: t.status,
    comment: String(comment).trim(),
  });

  db.prepare('UPDATE projects SET current_stage = ?, stage_entered_at = ? WHERE id = ?')
    .run(t.to, entry.payload.timestamp, project.id);

  return { project: getProject(db, project.id), entry, transition: t };
}

/**
 * Record a geo-tagged e-MB measurement. Only the JE takes site measurements, and not after
 * the smart contract has fired. The photo's own SHA-256 goes into the ledger payload, so
 * swapping the image file on disk is detectable too.
 */
export function recordMeasurement(db, { projectId, role, photo_url, photo_sha256, lat, lng, note = '' }) {
  const project = getProject(db, projectId);

  if (role !== 'JE') throw new WorkflowError(`Only the JE records site measurements — you are acting as ${role}.`);
  if (project.current_stage === 'PAYMENT_TRIGGERED') {
    throw new WorkflowError('Payment has already been triggered; the measurement book is closed.');
  }

  const latitude = Number(lat), longitude = Number(lng);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new WorkflowError('Latitude is missing or out of range — allow location access and try again.');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new WorkflowError('Longitude is missing or out of range — allow location access and try again.');
  }
  if (!photo_url) throw new WorkflowError('A site photo is required');

  const entry = appendLedgerEntry(db, 'MEASUREMENT', {
    project_id: project.id,
    photo_url, photo_sha256,
    lat: latitude, lng: longitude,
    note: String(note).trim(),
    actor_role: 'JE',
  });

  return { project: getProject(db, project.id), entry };
}

export function daysInStage(project, now = new Date()) {
  return (now - new Date(project.stage_entered_at)) / 86_400_000;
}

/** Decorate a project row with the derived fields the UI needs. */
export function decorate(db, project, now = new Date()) {
  const days = daysInStage(project, now);
  const terminal = project.current_stage === 'PAYMENT_TRIGGERED';
  return {
    ...project,
    stage_label: STAGES[project.current_stage]?.label ?? project.current_stage,
    stage_index: STAGE_ORDER.indexOf(project.current_stage),
    waiting_on: waitingOn(project.current_stage),
    days_in_stage: Math.floor(days),
    overdue: !terminal && days > SLA_DAYS,
    sla_days: SLA_DAYS,
    approvals: db.prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY seq ASC').all(project.id),
    measurements: db.prepare('SELECT * FROM measurements WHERE project_id = ? ORDER BY seq ASC').all(project.id),
  };
}

export function listProjects(db, now = new Date()) {
  return db.prepare('SELECT * FROM projects ORDER BY id ASC').all().map(p => {
    const d = decorate(db, p, now);
    return { ...d, approvals: undefined, measurements: undefined, entry_count: d.approvals.length + d.measurements.length };
  });
}
