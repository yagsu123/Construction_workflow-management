// JSON API. Routes return `true` if they handled the request.

import { getDb } from './db.js';
import { verifyChain } from './ledger.js';
import { checkAnchors } from './anchor.js';
import {
  createProject, getProject, act, decorate, listProjects, actionsFor,
  recordMeasurement, WorkflowError,
} from './workflow.js';
import { saveDataUrl, photoStillMatches } from './uploads.js';
import { ROLES, ROLE_IDS, STAGES, STAGE_ORDER, DEPARTMENTS, SLA_DAYS } from './config.js';

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new WorkflowError('Request body too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new WorkflowError('Body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function requireRole(role) {
  if (!ROLE_IDS.includes(role)) {
    throw new WorkflowError(`Unknown role "${role}". Expected one of ${ROLE_IDS.join(', ')}.`);
  }
  return role;
}

export async function handleApi(req, res, url) {
  const db = getDb();
  const { pathname } = url;
  const method = req.method;

  // --- metadata the UI builds itself from -------------------------------------------------
  if (pathname === '/api/health' && method === 'GET') {
    const chain = verifyChain(db);
    const anchors = checkAnchors(db);
    return json(res, 200, {
      ok: true, service: 'pwd-infra-workflow', phase: 4, node: process.version,
      chain: { length: chain.length, valid: chain.valid, first_break: chain.first_break },
      anchors: { checked: anchors.checked, valid: anchors.valid },
      time: new Date().toISOString(),
    });
  }

  if (pathname === '/api/meta' && method === 'GET') {
    return json(res, 200, {
      roles: ROLES, stages: STAGES, stage_order: STAGE_ORDER,
      departments: DEPARTMENTS, sla_days: SLA_DAYS,
    });
  }

  // --- projects ----------------------------------------------------------------------------
  if (pathname === '/api/projects' && method === 'GET') {
    return json(res, 200, { projects: listProjects(db) });
  }

  if (pathname === '/api/projects' && method === 'POST') {
    const body = await readJsonBody(req);
    const project = createProject(db, body);
    return json(res, 201, { project: decorate(db, project) });
  }

  const detail = pathname.match(/^\/api\/projects\/(\d+)$/);
  if (detail && method === 'GET') {
    const project = getProject(db, Number(detail[1]));
    const role = url.searchParams.get('role');
    return json(res, 200, {
      project: decorate(db, project),
      available_actions: role && ROLE_IDS.includes(role) ? actionsFor(project.current_stage, role) : [],
    });
  }

  const action = pathname.match(/^\/api\/projects\/(\d+)\/action$/);
  if (action && method === 'POST') {
    const body = await readJsonBody(req);
    const result = act(db, {
      projectId: Number(action[1]),
      role: requireRole(body.role),
      action: body.action,
      comment: body.comment ?? '',
    });
    return json(res, 200, {
      project: decorate(db, result.project),
      entry: { seq: result.entry.seq, hash: result.entry.hash, prev_hash: result.entry.prev_hash },
      moved_to: result.transition.to,
    });
  }

  // --- geo-tagged e-MB measurements ---------------------------------------------------------
  const measure = pathname.match(/^\/api\/projects\/(\d+)\/measurement$/);
  if (measure && method === 'POST') {
    const body = await readJsonBody(req, 8_000_000);
    let saved;
    try {
      saved = saveDataUrl(body.photo);
    } catch (err) {
      throw new WorkflowError(err.message);
    }
    const result = recordMeasurement(db, {
      projectId: Number(measure[1]),
      role: requireRole(body.role),
      photo_url: saved.url,
      photo_sha256: saved.sha256,
      lat: body.lat, lng: body.lng, note: body.note ?? '',
    });
    return json(res, 201, {
      project: decorate(db, result.project),
      entry: { seq: result.entry.seq, hash: result.entry.hash, prev_hash: result.entry.prev_hash },
      photo: saved,
    });
  }

  // --- delay dashboard ------------------------------------------------------------------------
  if (pathname === '/api/delays' && method === 'GET') {
    const projects = listProjects(db);
    const live = projects.filter(p => p.current_stage !== 'PAYMENT_TRIGGERED');

    // Where do files actually die? Attribute waiting time to the role holding each file.
    const byRole = {};
    for (const p of live) {
      if (!p.waiting_on) continue;
      const r = (byRole[p.waiting_on] ??= { role: p.waiting_on, files: 0, overdue: 0, total_days: 0, worst: 0 });
      r.files++;
      r.total_days += p.days_in_stage;
      r.worst = Math.max(r.worst, p.days_in_stage);
      if (p.overdue) r.overdue++;
    }
    for (const r of Object.values(byRole)) r.avg_days = Math.round((r.total_days / r.files) * 10) / 10;

    return json(res, 200, {
      sla_days: SLA_DAYS,
      total: projects.length,
      live: live.length,
      overdue: live.filter(p => p.overdue).length,
      completed: projects.length - live.length,
      by_role: Object.values(byRole).sort((a, b) => b.overdue - a.overdue || b.avg_days - a.avg_days),
      projects: projects.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.days_in_stage - a.days_in_stage),
    });
  }

  // --- ledger -------------------------------------------------------------------------------
  if (pathname === '/api/ledger' && method === 'GET') {
    const chain = verifyChain(db);
    // A measurement is only trustworthy if the image file on disk still hashes to what was signed.
    for (const e of chain.entries) {
      if (e.entry_type === 'MEASUREMENT' && e.photo_sha256) {
        e.photo_check = photoStillMatches(e.photo_url, e.photo_sha256);
      }
    }
    const anchors = checkAnchors(db);
    return json(res, 200, {
      valid: chain.valid && anchors.valid,
      chain_valid: chain.valid, length: chain.length, tip: chain.tip,
      first_break: chain.first_break, breaks: chain.breaks,
      anchors, entries: chain.entries,
    });
  }

  return json(res, 404, { error: 'No such endpoint', endpoint: pathname });
}
