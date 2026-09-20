// Tender initiation.
//
// Everything upstream of a contractor existing. A work package is defined, scrutinised,
// sanctioned and authorised before an Invitation to Tender is published; bidding and evaluation
// happen outside this system, and the flow resumes at the work order.
//
// The point of putting this on the ledger is not paperwork. It is that the scope, the BOQ and the
// estimate are SEALED before a single bill exists. A measurement that later exceeds the tendered
// quantity is then checkable against a record nobody can quietly revise — which is precisely the
// revision that makes scope creep invisible on paper.
//
// Three gates, three different officers, each recorded:
//
//   JE/AE prepare  ->  DEE scrutiny  ->  EE technical sanction  ->  EE authorises publication
//                      (sub-divisional            (estimate, rates,      (DSC PIN)
//                       technical approval)         budget head)
//
// Administrative Approval happens outside the system — a competent authority sanctions the work
// itself. We record its reference on the package rather than pretending to grant it here.

import { randomUUID, createHash } from 'node:crypto';
import { appendLedgerEntry } from './ledger.js';
import { WorkflowError } from './workflow.js';
import { TENDER_STAGES, TENDER_TRANSITIONS, DEFAULT_SITE_RADIUS_M, DSC_PIN } from './config.js';

/**
 * The canonical fingerprint of a procurement package: scope, BOQ, estimate and the commercial
 * requirements bidders will price against. Recomputed on every edit while the package is in
 * draft, then frozen into the ledger at publication.
 *
 * Deliberately excludes status, timestamps and officer names — those change as the package moves;
 * what bidders were shown must not.
 */
export function packageFingerprint(t) {
  const canonical = JSON.stringify({
    title: t.title,
    department: t.department,
    scope: t.scope ?? '',
    boq: JSON.parse(t.boq_json ?? '[]'),
    estimated_cost: Number(t.estimated_cost),
    completion_days: Number(t.completion_days),
    emd_amount: Number(t.emd_amount),
    eligibility: t.eligibility ?? '',
    ld_per_week_pct: Number(t.ld_per_week_pct ?? 0.5),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function getTender(db, id) {
  const row = db.prepare('SELECT * FROM tenders WHERE id = ?').get(id);
  if (!row) throw new WorkflowError('Tender not found', 404);
  return row;
}

export function listTenders(db) {
  return db.prepare('SELECT * FROM tenders ORDER BY created_at DESC').all().map(t => decorateTender(db, t));
}

export function decorateTender(db, t) {
  const stage = TENDER_STAGES[t.status];
  return {
    ...t,
    boq: JSON.parse(t.boq_json ?? '[]'),
    status_label: stage?.label ?? t.status,
    waiting_on: stage?.actor ?? null,
    is_published: t.status === 'PUBLISHED' || t.status === 'AWARDED',
    days_in_status: Math.floor((Date.now() - new Date(t.stage_entered_at)) / 86_400_000),
  };
}

export function tenderEvents(db, tenderId) {
  return db.prepare('SELECT * FROM tender_events WHERE tender_id = ? ORDER BY seq ASC').all(tenderId);
}

/** The actions this role may take on a tender in this status. */
export function tenderActionsFor(status, role) {
  return (TENDER_TRANSITIONS[status] || {})[role] || [];
}

// --- creating the package ---------------------------------------------------------------------

const REQUIRED = {
  title: 'a project title',
  department: 'a department',
  estimated_cost: 'an estimated cost',
  completion_days: 'a completion period in days',
};

function nextCode(db) {
  const year = new Date().getFullYear();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM tenders WHERE code LIKE ?`).get(`NIT/${year}/%`);
  return `NIT/${year}/${String(row.n + 1).padStart(3, '0')}`;
}

/**
 * Create a procurement package in draft. Only the JE or the AE prepare packages — an EE who could
 * write the estimate and then sanction it himself would make the sanction meaningless.
 */
export function createPackage(db, {
  role, actorUser = '', title, department, scope = '', boq = [],
  estimated_cost, completion_days, emd_amount = 0, eligibility = '',
  ld_per_week_pct = 0.5, aa_reference = '',
  site_lat = null, site_lng = null, site_radius_m = DEFAULT_SITE_RADIUS_M,
}, now = new Date()) {
  if (role !== 'JE' && role !== 'AE') {
    throw new WorkflowError(`Procurement packages are prepared by the JE or the AE — you are acting as ${role}.`, 403);
  }

  const values = { title, department, estimated_cost, completion_days };
  for (const [field, what] of Object.entries(REQUIRED)) {
    const v = values[field];
    if (v === undefined || v === null || v === '') throw new WorkflowError(`A tender package needs ${what}.`);
  }
  if (!(Number(estimated_cost) > 0)) throw new WorkflowError('The estimated cost must be greater than zero.');
  if (!(Number(completion_days) > 0)) throw new WorkflowError('The completion period must be at least one day.');
  if (!aa_reference) {
    throw new WorkflowError(
      'An Administrative Approval reference is required. The competent authority sanctions the ' +
      'work before a package is prepared — recording the reference is what ties this package to it.');
  }
  if (!Array.isArray(boq) || boq.length === 0) {
    throw new WorkflowError('A tender package needs at least one BOQ item — that is what bidders price.');
  }
  for (const item of boq) {
    if (!item?.description) throw new WorkflowError('Every BOQ item needs a description.');
    if (!(Number(item.quantity) > 0)) throw new WorkflowError(`BOQ item "${item.description}" needs a quantity.`);
    if (!item.unit) throw new WorkflowError(`BOQ item "${item.description}" needs a unit.`);
  }

  const id = randomUUID();
  const ts = now.toISOString();
  const draft = {
    id, code: nextCode(db), title: String(title).trim(), department,
    scope: String(scope).trim(), boq_json: JSON.stringify(boq),
    estimated_cost: Number(estimated_cost), completion_days: Number(completion_days),
    emd_amount: Number(emd_amount), eligibility: String(eligibility).trim(),
    ld_per_week_pct: Number(ld_per_week_pct), aa_reference: String(aa_reference).trim(),
  };
  const package_sha256 = packageFingerprint(draft);

  db.prepare(`
    INSERT INTO tenders (id, code, title, department, scope, boq_json, estimated_cost,
                         completion_days, emd_amount, eligibility, ld_per_week_pct, aa_reference,
                         package_sha256, status, site_lat, site_lng, site_radius_m,
                         created_at, stage_entered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PACKAGE_DRAFT', ?, ?, ?, ?, ?)
  `).run(draft.id, draft.code, draft.title, draft.department, draft.scope, draft.boq_json,
         draft.estimated_cost, draft.completion_days, draft.emd_amount, draft.eligibility,
         draft.ld_per_week_pct, draft.aa_reference, package_sha256,
         site_lat, site_lng, site_radius_m, ts, ts);

  const entry = appendTenderEvent(db, {
    tender_id: id, event: 'PACKAGE_CREATED', status: 'PACKAGE_DRAFT',
    actor_role: role, actor_user: actorUser, package_sha256,
    estimated_cost: draft.estimated_cost,
    comment: `Package prepared under AA ${draft.aa_reference}`,
  }, ts);

  return { tender: decorateTender(db, getTender(db, id)), entry };
}

/** Revise a package that is still in draft, or that was returned by the DEE or the EE. */
export function revisePackage(db, { tenderId, role, actorUser = '', patch = {} }, now = new Date()) {
  const t = getTender(db, tenderId);
  if (role !== 'JE' && role !== 'AE') {
    throw new WorkflowError(`Packages are revised by the JE or the AE — you are acting as ${role}.`, 403);
  }
  if (t.status !== 'PACKAGE_DRAFT') {
    throw new WorkflowError(
      `${t.code} is at ${TENDER_STAGES[t.status]?.label ?? t.status} and can no longer be edited. ` +
      `A package under scrutiny must be returned before it can change.`);
  }

  const EDITABLE = ['title', 'department', 'scope', 'estimated_cost', 'completion_days',
                    'emd_amount', 'eligibility', 'ld_per_week_pct', 'aa_reference',
                    'site_lat', 'site_lng', 'site_radius_m'];
  const next = { ...t };
  for (const key of EDITABLE) if (patch[key] !== undefined) next[key] = patch[key];
  if (patch.boq !== undefined) next.boq_json = JSON.stringify(patch.boq);

  const package_sha256 = packageFingerprint(next);
  const ts = now.toISOString();

  db.prepare(`
    UPDATE tenders SET title = ?, department = ?, scope = ?, boq_json = ?, estimated_cost = ?,
                       completion_days = ?, emd_amount = ?, eligibility = ?, ld_per_week_pct = ?,
                       aa_reference = ?, site_lat = ?, site_lng = ?, site_radius_m = ?,
                       package_sha256 = ?
     WHERE id = ?
  `).run(next.title, next.department, next.scope, next.boq_json, Number(next.estimated_cost),
         Number(next.completion_days), Number(next.emd_amount), next.eligibility,
         Number(next.ld_per_week_pct), next.aa_reference,
         next.site_lat, next.site_lng, next.site_radius_m, package_sha256, t.id);

  // Only record a revision that actually changed what bidders would be priced against.
  const entry = package_sha256 === t.package_sha256 ? null : appendTenderEvent(db, {
    tender_id: t.id, event: 'PACKAGE_REVISED', status: 'PACKAGE_DRAFT',
    actor_role: role, actor_user: actorUser, package_sha256,
    estimated_cost: Number(next.estimated_cost),
    comment: 'Package revised in draft',
  }, ts);

  return { tender: decorateTender(db, getTender(db, t.id)), entry };
}

// --- the gates ----------------------------------------------------------------------------------

/**
 * Move a tender through its authorisation gates. Every move is appended to the shared chain
 * before the status changes — including a return, which is the one a paper file loses.
 */
export function actOnTender(db, {
  tenderId, role, actorUser = '', action, comment = '',
  budget_head = '', bid_due_date = null, dsc_pin = null, contractor = '',
}, now = new Date()) {
  const t = getTender(db, tenderId);
  const available = tenderActionsFor(t.status, role);
  const move = available.find(a => a.action === action);

  if (!move) {
    const actor = TENDER_STAGES[t.status]?.actor;
    throw new WorkflowError(
      actor
        ? `${role} cannot "${action}" a tender at ${TENDER_STAGES[t.status]?.label ?? t.status} — it is with the ${actor}.`
        : `${t.code} is at ${t.status}; no further action is available.`);
  }
  if (move.needsComment && !String(comment).trim()) {
    throw new WorkflowError(`"${move.label}" needs a reason — that reason is what goes on the ledger.`);
  }

  const ts = now.toISOString();
  const patch = {};

  if (action === 'accord_ts') {
    if (!String(budget_head).trim()) {
      throw new WorkflowError(
        'Technical Sanction requires a budget head. Sanctioning an estimate with no head of ' +
        'account against it is how a package reaches tender with no money behind it.');
    }
    patch.budget_head = String(budget_head).trim();
    patch.ts_by = actorUser;
    patch.ts_at = ts;
  }

  if (action === 'publish_itt') {
    if (dsc_pin !== DSC_PIN) throw new WorkflowError('Invalid DSC PIN — publication must be signed.', 403);
    if (!bid_due_date) throw new WorkflowError('An ITT needs a last date for submission of bids.');
    if (new Date(bid_due_date) <= new Date(ts)) {
      throw new WorkflowError('The last date for bids must be in the future.');
    }
    patch.itt_published_at = ts;
    patch.bid_due_date = new Date(bid_due_date).toISOString();
  }

  if (action === 'award') {
    if (!String(contractor).trim()) throw new WorkflowError('A work order needs the contractor on record.');
  }

  const entry = appendTenderEvent(db, {
    tender_id: t.id, event: move.event, status: move.to,
    actor_role: role, actor_user: actorUser,
    package_sha256: t.package_sha256, estimated_cost: t.estimated_cost,
    comment: String(comment).trim() || move.label,
  }, ts);

  const sets = ['status = ?', 'stage_entered_at = ?'];
  const args = [move.to, ts];
  for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); args.push(v); }
  args.push(t.id);
  db.prepare(`UPDATE tenders SET ${sets.join(', ')} WHERE id = ?`).run(...args);

  // Awarding is where the tender hands over to the execution workflow: the project is created
  // at DRAFT, carrying the tendered figures and the site the package registered.
  let project = null;
  if (action === 'award') project = awardToProject(db, t.id, contractor, ts);

  return { tender: decorateTender(db, getTender(db, t.id)), entry, project, transition: move };
}

/** Create the execution-side project from an awarded tender and link the two. */
function awardToProject(db, tenderId, contractor, ts) {
  const t = getTender(db, tenderId);
  const year = new Date(ts).getFullYear();
  const n = db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE code LIKE ?`).get(`PWD/${year}/%`).n;
  const code = `PWD/${year}/${String(n + 1).padStart(3, '0')}`;

  const id = Number(db.prepare(`
    INSERT INTO projects (code, title, budget, department, contractor, site_lat, site_lng,
                          site_radius_m, current_stage, stage_entered_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
  `).run(code, t.title, t.estimated_cost, t.department, String(contractor).trim(),
         t.site_lat, t.site_lng, t.site_radius_m ?? DEFAULT_SITE_RADIUS_M, ts, ts).lastInsertRowid);

  db.prepare('UPDATE tenders SET project_id = ? WHERE id = ?').run(id, t.id);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

// --- ledger -------------------------------------------------------------------------------------

function appendTenderEvent(db, data, timestamp) {
  return appendLedgerEntry(db, 'TENDER_EVENT', { ...data, timestamp });
}
