// Workflow rules: who may act, what each action does, and how a project moves between stages.
// Every action is written to the ledger — including rejections, which is the point.

import { appendLedgerEntry } from './ledger.js';
import { withinRadius, isValidLat, isValidLng, haversineMetres, formatDistance } from './geo.js';
import { reason as delayReason, isReason, daysBetween } from './delays.js';
import {
  STAGES, STAGE_ORDER, SLA_DAYS,
  DEFAULT_SITE_RADIUS_M, EXIF_DRIFT_M, EXIF_MAX_AGE_HOURS, EXIF_POLICY,
} from './config.js';
import { randomUUID } from 'node:crypto';

/**
 * The actions available from each stage, keyed by the role allowed to take them.
 * `to` is the stage the project lands in; `status` is what goes on the ledger.
 */
export const TRANSITIONS = {
  DRAFT: {
    CONTRACTOR: [{ action: 'submit_ra', label: 'Submit RA Bill', status: 'RA_SUBMITTED', to: 'PENDING_JE', tone: 'primary' }],
  },
  PENDING_JE: {
    JE: [{ action: 'submit', label: 'Submit for AE test-check', status: 'SUBMITTED', to: 'PENDING_AE', tone: 'primary' }],
  },
  // The AE re-measures a prescribed percentage of the JE's entries. Mandatory in PWD practice,
  // and the gate most often blamed for delay - which is exactly why it is instrumented here.
  // The DEE then re-checks 30% himself and accords sub-divisional technical approval: two
  // independent physical checks before the file is allowed anywhere near the EE.
  PENDING_AE: {
    AE: [
      { action: 'test_check', label: 'Test-check passed', status: 'TEST_CHECKED', to: 'PENDING_DEE', tone: 'primary' },
      { action: 'reject', label: 'Measurement mismatch', status: 'REJECTED', to: 'PENDING_JE', tone: 'danger', needsComment: true },
    ],
  },
  PENDING_DEE: {
    DEE: [
      { action: 'tech_approve', label: 'Accord sub-divisional technical approval', status: 'TECH_APPROVED', to: 'PENDING_EE', tone: 'primary' },
      { action: 'reject', label: 'Test-check mismatch at sub-division', status: 'REJECTED', to: 'PENDING_JE', tone: 'danger', needsComment: true },
    ],
  },
  PENDING_EE: {
    EE: [
      { action: 'approve', label: 'Grant final approval (Requires DSC PIN)', status: 'APPROVED', to: 'APPROVED', tone: 'primary' },
      { action: 'reject', label: 'Reject', status: 'REJECTED', to: 'PENDING_JE', tone: 'danger', needsComment: true },
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

export function createProject(db, {
  title, budget, department, contractor = '',
  site_lat = null, site_lng = null, site_radius_m = null,
}) {
  if (!title || !String(title).trim()) throw new WorkflowError('Title is required');
  const amount = Number(budget);
  if (!Number.isFinite(amount) || amount <= 0) throw new WorkflowError('Budget must be a positive number');
  if (!department) throw new WorkflowError('Department is required');

  // The geofence centre is optional, but if given it must be a real point — a half-specified
  // site would silently disable the fence.
  const hasSite = site_lat !== null && site_lat !== '' && site_lng !== null && site_lng !== '';
  if (hasSite && (!isValidLat(site_lat) || !isValidLng(site_lng))) {
    throw new WorkflowError('Site coordinates are out of range');
  }

  const now = new Date().toISOString();
  const n = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c + 1;
  const code = `PWD/${new Date().getFullYear()}/${String(n).padStart(3, '0')}`;

  const id = db.prepare(`
    INSERT INTO projects (code, title, budget, department, contractor,
                          site_lat, site_lng, site_radius_m,
                          current_stage, stage_entered_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
  `).run(code, String(title).trim(), amount, department, contractor,
         hasSite ? Number(site_lat) : null, hasSite ? Number(site_lng) : null,
         hasSite && site_radius_m ? Number(site_radius_m) : null,
         now, now).lastInsertRowid;

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
export function act(db, { projectId, role, actorUser = '', action, comment = '' }) {
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
    actor_user: actorUser,
    status: t.status,
    comment: String(comment).trim(),
  });

  db.prepare('UPDATE projects SET current_stage = ?, stage_entered_at = ? WHERE id = ?')
    .run(t.to, entry.payload.timestamp, project.id);

  return { project: getProject(db, project.id), entry, transition: t };
}

/**
 * Verify a photo against the claim being made about it.
 *
 * Hashing the photo proves the file has not changed since it was signed. It does not prove the
 * photo is of that place at that time — for that we read the photo's own EXIF GPS and capture
 * time and cross-check them against the browser's reported fix.
 *
 * Absence and contradiction are treated differently, deliberately:
 *   - no EXIF at all      -> UNVERIFIED, accepted under the default policy (many devices and
 *                            every screenshot strip it; absence is not evidence of fraud)
 *   - EXIF that disagrees -> rejected outright under every policy
 *
 * @returns {{verdict:'EXIF_CONFIRMED'|'UNVERIFIED', exif_lat, exif_lng, exif_taken_at, drift_m}}
 * @throws {WorkflowError} when the EXIF contradicts the claim
 */
export function verifyPhotoAgainstClaim(exif, { lat, lng }, now = new Date()) {
  const hasGps = exif?.present && exif.lat !== null && exif.lng !== null;

  if (!hasGps) {
    if (EXIF_POLICY === 'strict') {
      throw new WorkflowError(
        'This photo carries no embedded GPS data. Site policy requires a camera photo with ' +
        'location services enabled — a screenshot or a shared image will not do.');
    }
    return {
      verdict: 'UNVERIFIED', drift_m: null,
      exif_lat: null, exif_lng: null, exif_taken_at: exif?.taken_at ?? null,
    };
  }

  const drift_m = Math.round(haversineMetres(exif.lat, exif.lng, lat, lng));
  if (drift_m > EXIF_DRIFT_M) {
    throw new WorkflowError(
      `The photo's own GPS is ${formatDistance(drift_m)} from the location reported by this ` +
      `device. The photo was not taken where this entry claims it was.`);
  }

  if (exif.taken_at) {
    const ageHours = (now - new Date(exif.taken_at)) / 3_600_000;
    if (ageHours > EXIF_MAX_AGE_HOURS) {
      throw new WorkflowError(
        `This photo was taken ${Math.round(ageHours / 24)} day(s) ago. An e-MB entry must be ` +
        `recorded from a photo taken within ${EXIF_MAX_AGE_HOURS} hours.`);
    }
    if (ageHours < -1) {
      throw new WorkflowError('This photo carries a capture time in the future.');
    }
  }

  return {
    verdict: 'EXIF_CONFIRMED', drift_m,
    exif_lat: exif.lat, exif_lng: exif.lng, exif_taken_at: exif.taken_at ?? null,
  };
}

/**
 * Record a geo-tagged e-MB measurement. Only the JE takes site measurements, and not after
 * the smart contract has fired. Three things must hold:
 *
 *   1. the reported position is inside the project's registered geofence
 *   2. the photo's EXIF does not contradict that position or the time
 *   3. the photo's own SHA-256 goes into the ledger payload, so swapping the file is detectable
 */
export function recordMeasurement(db, {
  projectId, role, actorUser = '', photo_url, photo_sha256, lat, lng, note = '', exif = null,
}, now = new Date()) {
  const project = getProject(db, projectId);

  if (role !== 'JE') throw new WorkflowError(`Only the JE records site measurements — you are acting as ${role}.`);
  if (project.current_stage === 'PAYMENT_TRIGGERED') {
    throw new WorkflowError('Payment has already been triggered; the measurement book is closed.');
  }

  if (!isValidLat(lat)) {
    throw new WorkflowError('Latitude is missing or out of range — allow location access and try again.');
  }
  if (!isValidLng(lng)) {
    throw new WorkflowError('Longitude is missing or out of range — allow location access and try again.');
  }
  if (!photo_url) throw new WorkflowError('A site photo is required');

  const latitude = Number(lat), longitude = Number(lng);

  // --- 1. geofence -----------------------------------------------------------------------
  let distance_m = null;
  if (project.site_lat !== null && project.site_lng !== null) {
    const radius = project.site_radius_m ?? DEFAULT_SITE_RADIUS_M;
    const fix = withinRadius(
      { lat: latitude, lng: longitude },
      { lat: project.site_lat, lng: project.site_lng },
      radius,
    );
    distance_m = fix.distance_m;
    if (!fix.inside) {
      throw new WorkflowError(
        `You are ${formatDistance(fix.distance_m)} from the registered site for ${project.code}, ` +
        `which allows ${formatDistance(radius)}. An e-MB entry can only be recorded on site.`);
    }
  }

  // --- 2. the photo's own account of itself -----------------------------------------------
  const check = verifyPhotoAgainstClaim(exif, { lat: latitude, lng: longitude }, now);

  // --- 3. sign it --------------------------------------------------------------------------
  const entry = appendLedgerEntry(db, 'MEASUREMENT', {
    project_id: project.id,
    photo_url, photo_sha256,
    lat: latitude, lng: longitude,
    note: String(note).trim(),
    actor_role: 'JE',
    actor_user: actorUser,
    exif_lat: check.exif_lat, exif_lng: check.exif_lng, exif_taken_at: check.exif_taken_at,
    photo_verified: check.verdict,
    distance_m,
  });

  return { project: getProject(db, project.id), entry, verification: check, distance_m };
}

// --- Ground delay & EOT Requests ------------------------------------------------------------

export function logDelay(db, { projectId, role, actorUser = '', category, responsibility, start_date, impact_days, description = '', evidence_url = null }) {
  const project = getProject(db, projectId);

  if (role !== 'JE' && role !== 'CONTRACTOR') {
    throw new WorkflowError(`Delays are logged by the JE or CONTRACTOR — you are acting as ${role}.`);
  }

  const start = start_date ?? new Date().toISOString();
  if (new Date(start) > new Date()) throw new WorkflowError('A delay cannot start in the future.');

  const id = randomUUID();
  const entry = appendLedgerEntry(db, 'DELAY_LOG', {
    id, project_id: project.id, reported_by_role: role,
    delay_category: category, delay_responsibility: responsibility,
    start_date: start, estimated_end_date: null, actual_end_date: null,
    impact_days: Number(impact_days), description: String(description).trim(),
    evidence_document_url: evidence_url, status: 'LOGGED',
    actor_user: actorUser,
  });

  return { project, entry };
}

export function createEotRequest(db, { delayLogId, role, actorUser = '', requested_days }) {
  const delayLog = db.prepare('SELECT * FROM delay_logs WHERE id = ?').get(delayLogId);
  if (!delayLog) throw new WorkflowError('Delay log not found');
  const project = getProject(db, delayLog.project_id);
  
  if (role !== 'JE' && role !== 'CONTRACTOR') {
    throw new WorkflowError(`EOT requests are initiated by the JE or CONTRACTOR.`);
  }

  // Change delay status to UNDER_REVIEW
  db.prepare('UPDATE delay_logs SET status = ? WHERE id = ?').run('UNDER_REVIEW', delayLogId);

  const id = randomUUID();
  const entry = appendLedgerEntry(db, 'EOT_APPROVAL', {
    id, project_id: project.id, delay_log_id: delayLogId, requested_days: Number(requested_days),
    recommended_days_by_ae: null, approved_days_by_ee: null,
    status: 'PENDING_AE', rejection_reason: null, actor_role: role, actor_user: actorUser,
    ledger_block_hash: '', 
  });

  return { project, entry };
}

export function recommendEot(db, { eotId, role, actorUser = '', recommended_days }) {
  if (role !== 'AE') throw new WorkflowError(`Only the AE can recommend EOT.`);
  const eot = db.prepare('SELECT * FROM eot_requests WHERE id = ?').get(eotId);
  if (!eot) throw new WorkflowError('EOT request not found');
  if (eot.status !== 'PENDING_AE') throw new WorkflowError('EOT is not pending AE review');

  const entry = appendLedgerEntry(db, 'EOT_APPROVAL', {
    id: eot.id, project_id: eot.project_id, delay_log_id: eot.delay_log_id,
    requested_days: eot.requested_days, recommended_days_by_ae: Number(recommended_days),
    approved_days_by_ee: null, status: 'PENDING_EE', rejection_reason: null,
    actor_role: role, actor_user: actorUser, ledger_block_hash: '',
  });

  db.prepare('UPDATE eot_requests SET recommended_days_by_ae = ?, status = ? WHERE id = ?')
    .run(Number(recommended_days), 'PENDING_EE', eot.id);

  return { entry };
}

export function approveEot(db, { eotId, role, actorUser = '', approved_days, status, rejection_reason = '' }) {
  if (role !== 'EE') throw new WorkflowError(`Only the EE can approve or reject EOT.`);
  const eot = db.prepare('SELECT * FROM eot_requests WHERE id = ?').get(eotId);
  if (!eot) throw new WorkflowError('EOT request not found');
  if (eot.status !== 'PENDING_EE') throw new WorkflowError('EOT is not pending EE review');
  
  if (status !== 'APPROVED' && status !== 'REJECTED') throw new WorkflowError('Invalid status');

  const entry = appendLedgerEntry(db, 'EOT_APPROVAL', {
    id: eot.id, project_id: eot.project_id, delay_log_id: eot.delay_log_id,
    requested_days: eot.requested_days, recommended_days_by_ae: eot.recommended_days_by_ae,
    approved_days_by_ee: status === 'APPROVED' ? Number(approved_days) : null,
    status, rejection_reason: status === 'REJECTED' ? String(rejection_reason).trim() : null,
    actor_role: role, actor_user: actorUser, ledger_block_hash: '',
  });

  db.prepare('UPDATE delay_logs SET status = ? WHERE id = ?').run('RESOLVED', eot.delay_log_id);
  db.prepare('UPDATE eot_requests SET approved_days_by_ee = ?, status = ?, rejection_reason = ?, ledger_block_hash = ? WHERE id = ?')
    .run(status === 'APPROVED' ? Number(approved_days) : null, status, status === 'REJECTED' ? String(rejection_reason).trim() : null, entry.hash, eot.id);

  return { entry };
}

export function allDelays(db, projectId) {
  const logs = db.prepare('SELECT * FROM delay_logs WHERE project_id = ? ORDER BY seq ASC').all(projectId);
  for (const log of logs) {
    log.eot_requests = db.prepare('SELECT * FROM eot_requests WHERE delay_log_id = ? ORDER BY seq ASC').all(log.id);
  }
  return logs;
}

export function delaySummary(db, projectId, now = new Date()) {
  const logs = allDelays(db, projectId);
  
  const byParty = {};
  const byReason = {};
  let total_days = 0;
  let contractor_days = 0;
  let excusable_days = 0;
  let approved_eot_days = 0;

  for (const d of logs) {
    let approved = 0;
    for (const eot of d.eot_requests) {
      if (eot.status === 'APPROVED') {
        approved += eot.approved_days_by_ee;
        if (d.delay_responsibility === 'DEPARTMENT' || d.delay_responsibility === 'NEUTRAL') {
          approved_eot_days += eot.approved_days_by_ee;
        }
      }
    }

    const days = Math.max(d.impact_days, approved);
    (byParty[d.delay_responsibility] ??= { party: d.delay_responsibility, days: 0, open: 0 }).days += days;
    if (d.status !== 'RESOLVED') byParty[d.delay_responsibility].open++;
    
    const r = (byReason[d.delay_category] ??= {
      reason_code: d.delay_category, label: d.delay_category,
      party: d.delay_responsibility, excusable: (d.delay_responsibility !== 'CONTRACTOR'),
      days: 0, occurrences: 0, open: 0, projects: 0,
    });
    r.days += days; r.occurrences++; 
    if (d.status !== 'RESOLVED') r.open++;

    total_days += days;
    if (d.delay_responsibility === 'CONTRACTOR') contractor_days += days;
    if (d.delay_responsibility !== 'CONTRACTOR') excusable_days += days;
  }

  const open = logs.filter(d => d.status !== 'RESOLVED');
  return {
    total_days,
    excusable_days,
    contractor_days,
    approved_eot_days,
    open_count: open.length,
    on_hold: open.length > 0,
    by_party: Object.values(byParty).sort((a, b) => b.days - a.days),
    by_reason: Object.values(byReason).sort((a, b) => b.days - a.days),
  };
}

export function daysInStage(project, now = new Date()) {
  return (now - new Date(project.stage_entered_at)) / 86_400_000;
}

/** Decorate a project row with the derived fields the UI needs. */
export function decorate(db, project, now = new Date()) {
  const days = daysInStage(project, now);
  const terminal = project.current_stage === 'PAYMENT_TRIGGERED';
  const delays = delaySummary(db, project.id, now);
  const open = allDelays(db, project.id).filter(d => d.status !== 'RESOLVED');
  
  // Calculate adjusted SLA days based on approved EOT extensions
  const effective_sla_days = SLA_DAYS + delays.approved_eot_days;
  
  // LD Calculation for contractor delays past SLA
  const total_project_days = (now - new Date(project.created_at)) / 86_400_000;
  let ld_amount = 0;
  let penalty_weeks = 0;
  
  if (!terminal && total_project_days > effective_sla_days) {
    // If the project is past effective SLA, trigger LD on contractor delays
    // Liquidated Damages (LD) penalty calculation (0.5% budget deduction per week of delay)
    // Delay weeks = contractor_days / 7
    penalty_weeks = Math.floor(delays.contractor_days / 7);
    if (penalty_weeks > 0) {
      ld_amount = (0.005 * project.budget) * penalty_weeks;
    }
  }

  return {
    ...project,
    stage_label: STAGES[project.current_stage]?.label ?? project.current_stage,
    stage_index: STAGE_ORDER.indexOf(project.current_stage),
    waiting_on: waitingOn(project.current_stage),
    days_in_stage: Math.floor(days),
    overdue: !terminal && total_project_days > effective_sla_days && open.length === 0,
    on_hold: open.length > 0,
    held_overdue: !terminal && total_project_days > effective_sla_days && open.length > 0,
    sla_days: SLA_DAYS,
    effective_sla_days,
    ld_amount,
    penalty_weeks,
    delays,
    open_delays: open,
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
