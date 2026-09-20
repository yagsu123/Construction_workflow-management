// JSON API. Routes return `true` if they handled the request.

import { getDb } from './db.js';
import { verifyChain } from './ledger.js';
import { checkAnchors } from './anchor.js';
import {
  createProject, getProject, act, decorate, listProjects, actionsFor,
  recordMeasurement, logDelay, createEotRequest, recommendEot, approveEot, allDelays, delaySummary, WorkflowError,
} from './workflow.js';
import { REASONS } from './delays.js';
import {
  createPackage, revisePackage, actOnTender, listTenders, getTender, decorateTender,
  tenderEvents, tenderActionsFor,
} from './tender.js';
import { saveDataUrl, photoStillMatches, MAX_REQUEST_BYTES } from './uploads.js';
import { readExif } from './exif.js';
import {
  verifyCredentials, createSession, getSession, destroySession,
  parseCookies, sessionCookie, clearCookie, COOKIE, DEMO_ACCOUNTS, demoPassword, actorId,
} from './auth.js';
import {
  ROLES, ROLE_IDS, STAGES, STAGE_ORDER, DEPARTMENTS, SLA_DAYS,
  DEFAULT_SITE_RADIUS_M, EXIF_POLICY, DSC_PIN,
  TENDER_STAGES, TENDER_STAGE_ORDER,
} from './config.js';

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
    let tooBig = false;
    const chunks = [];
    req.on('data', c => {
      if (tooBig) return;                       // already rejected; just drain
      size += c.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;                      // release what we buffered
        // Deliberately NOT req.destroy(): killing the socket here means the client sees a
        // dropped connection instead of the 413 explaining what happened. Drain instead, so
        // the response can actually be written.
        reject(new WorkflowError(
          `Request body is larger than ${Math.round(limit / 1048576)} MB`, 413));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;                       // already settled
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new WorkflowError('Body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * The only way to get a role. The `role` field in a request body is never consulted:
 * identity comes from the session cookie, which requires a password to obtain.
 */
function requireSession(req) {
  const user = getSession(parseCookies(req.headers.cookie)[COOKIE]);
  if (!user) throw new WorkflowError('Not signed in', 401);
  return user;
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
      ok: true, service: 'pwd-infra-workflow', phase: 5, auth: true, node: process.version,
      chain: { length: chain.length, valid: chain.valid, first_break: chain.first_break },
      anchors: { checked: anchors.checked, valid: anchors.valid },
      time: new Date().toISOString(),
    });
  }

  // --- authentication ---------------------------------------------------------------------
  if (pathname === '/api/login' && method === 'POST') {
    const { username, password } = await readJsonBody(req);
    const user = verifyCredentials(username, password);
    if (!user) throw new WorkflowError('Incorrect username or password', 401);
    const token = createSession(user.username);
    res.setHeader('set-cookie', sessionCookie(token));
    return json(res, 200, { user });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    destroySession(parseCookies(req.headers.cookie)[COOKIE]);
    res.setHeader('set-cookie', clearCookie());
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && method === 'GET') {
    const user = getSession(parseCookies(req.headers.cookie)[COOKIE]);
    if (!user) return json(res, 401, { error: 'Not signed in' });
    return json(res, 200, { user });
  }

  // The demo accounts are listed so judges can sign in; the password still has to be typed,
  // and this endpoint never reveals a hash.
  if (pathname === '/api/demo-accounts' && method === 'GET') {
    return json(res, 200, { accounts: DEMO_ACCOUNTS, password: demoPassword() });
  }

  if (pathname === '/api/meta' && method === 'GET') {
    return json(res, 200, {
      roles: ROLES, stages: STAGES, stage_order: STAGE_ORDER,
      departments: DEPARTMENTS, sla_days: SLA_DAYS,
      delay_reasons: REASONS,
      geofence: { default_radius_m: DEFAULT_SITE_RADIUS_M, exif_policy: EXIF_POLICY },
      tender_stages: TENDER_STAGES, tender_stage_order: TENDER_STAGE_ORDER,
    });
  }

  // --- projects ----------------------------------------------------------------------------
  if (pathname === '/api/projects' && method === 'GET') {
    return json(res, 200, { projects: listProjects(db) });
  }

  if (pathname === '/api/projects' && method === 'POST') {
    const user = requireSession(req);
    if (user.role !== 'JE') throw new WorkflowError(`Only the JE creates a DPR — you are signed in as ${user.role}.`, 403);
    const body = await readJsonBody(req);
    const project = createProject(db, body);
    return json(res, 201, { project: decorate(db, project) });
  }

  const detail = pathname.match(/^\/api\/projects\/(\d+)$/);
  if (detail && method === 'GET') {
    const project = getProject(db, Number(detail[1]));
    const user = getSession(parseCookies(req.headers.cookie)[COOKIE]);
    return json(res, 200, {
      project: decorate(db, project),
      available_actions: user ? actionsFor(project.current_stage, user.role) : [],
      acting_as: user ?? null,
    });
  }

  const action = pathname.match(/^\/api\/projects\/(\d+)\/action$/);
  if (action && method === 'POST') {
    const user = requireSession(req);
    const body = await readJsonBody(req);
    
    if (body.action === 'approve' && user.role === 'EE') {
      if (body.dsc_pin !== DSC_PIN) {
        throw new WorkflowError('Invalid DSC PIN for final approval.', 403);
      }
    }
    
    const result = act(db, {
      projectId: Number(action[1]),
      role: user.role,                      // NOT body.role - the client does not get a vote
      actorUser: actorId(user.username),
      action: body.action,
      comment: body.comment ?? '',
    });
    return json(res, 200, {
      project: decorate(db, result.project),
      entry: { seq: result.entry.seq, hash: result.entry.hash, prev_hash: result.entry.prev_hash },
      moved_to: result.transition.to,
      acting_as: user,
    });
  }

  // --- geo-tagged e-MB measurements ---------------------------------------------------------
  const measure = pathname.match(/^\/api\/projects\/(\d+)\/measurement$/);
  if (measure && method === 'POST') {
    const user = requireSession(req);
    const body = await readJsonBody(req, MAX_REQUEST_BYTES);
    let saved;
    try {
      saved = saveDataUrl(body.photo);
    } catch (err) {
      throw new WorkflowError(err.message);
    }
    const result = recordMeasurement(db, {
      projectId: Number(measure[1]),
      role: user.role,                      // NOT body.role
      actorUser: actorId(user.username),
      photo_url: saved.url,
      photo_sha256: saved.sha256,
      lat: body.lat, lng: body.lng, note: body.note ?? '',
      exif: readExif(saved.buffer),         // read from the stored bytes, not from the client
    });
    return json(res, 201, {
      project: decorate(db, result.project),
      entry: { seq: result.entry.seq, hash: result.entry.hash, prev_hash: result.entry.prev_hash },
      photo: { url: saved.url, sha256: saved.sha256, bytes: saved.bytes },
      verification: result.verification,
      distance_m: result.distance_m,
    });
  }

  // --- delay logs & EOT requests ----------------------------------------------------------------
  const delayPost = pathname.match(/^\/api\/projects\/(\d+)\/delays$/);
  if (delayPost && method === 'POST') {
    const user = requireSession(req);
    const body = await readJsonBody(req, MAX_REQUEST_BYTES);
    let evidence_url = null;
    if (body.evidence) {
      try {
        const saved = saveDataUrl(body.evidence);
        evidence_url = saved.url;
      } catch (err) {
        throw new WorkflowError(err.message);
      }
    }
    const result = logDelay(db, {
      projectId: Number(delayPost[1]), role: user.role, actorUser: actorId(user.username),
      category: body.delay_category, responsibility: body.delay_responsibility,
      start_date: body.start_date, impact_days: body.impact_days, description: body.description ?? '',
      evidence_url,
    });
    return json(res, 201, {
      project: decorate(db, result.project),
      entry: { seq: result.entry.seq, hash: result.entry.hash },
    });
  }
  if (delayPost && method === 'GET') {
    const project = getProject(db, Number(delayPost[1]));
    return json(res, 200, {
      delays: allDelays(db, project.id),
      summary: delaySummary(db, project.id),
    });
  }

  const eotPost = pathname.match(/^\/api\/eot$/);
  if (eotPost && method === 'POST') {
    const user = requireSession(req);
    const body = await readJsonBody(req);
    const result = createEotRequest(db, {
      delayLogId: body.delay_log_id, role: user.role, actorUser: actorId(user.username),
      requested_days: body.requested_days,
    });
    return json(res, 201, {
      project: decorate(db, result.project),
      entry: { seq: result.entry.seq, hash: result.entry.hash },
    });
  }

  const eotRecommend = pathname.match(/^\/api\/eot\/([0-9a-fA-F-]+)\/recommend$/);
  if (eotRecommend && method === 'POST') {
    const user = requireSession(req);
    const body = await readJsonBody(req);
    const result = recommendEot(db, {
      eotId: eotRecommend[1], role: user.role, actorUser: actorId(user.username),
      recommended_days: body.recommended_days,
    });
    return json(res, 200, {
      entry: { seq: result.entry.seq, hash: result.entry.hash },
    });
  }

  const eotApprove = pathname.match(/^\/api\/eot\/([0-9a-fA-F-]+)\/approve$/);
  if (eotApprove && method === 'POST') {
    const user = requireSession(req);
    const body = await readJsonBody(req);
    const result = approveEot(db, {
      eotId: eotApprove[1], role: user.role, actorUser: actorId(user.username),
      approved_days: body.approved_days, status: body.status, rejection_reason: body.rejection_reason,
    });
    return json(res, 200, {
      entry: { seq: result.entry.seq, hash: result.entry.hash },
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

    // Ground delay, aggregated across every project. Administrative delay (which desk the file
    // is on) and ground delay (why the work stopped) are reported separately on purpose.
    const ground = { total_days: 0, excusable_days: 0, contractor_days: 0, on_hold: 0 };
    const byReason = {}, byParty = {};
    for (const p of projects) {
      const s = delaySummary(db, p.id);
      ground.total_days += s.total_days;
      ground.excusable_days += s.excusable_days;
      ground.contractor_days += s.contractor_days;
      if (s.on_hold) ground.on_hold++;
      for (const r of s.by_reason) {
        const acc = (byReason[r.reason_code] ??= { ...r, days: 0, occurrences: 0, open: 0, projects: 0 });
        acc.days += r.days; acc.occurrences += r.occurrences; acc.open += r.open; acc.projects++;
      }
      for (const q of s.by_party) {
        const acc = (byParty[q.party] ??= { party: q.party, days: 0, open: 0 });
        acc.days += q.days; acc.open += q.open;
      }
    }

    return json(res, 200, {
      sla_days: SLA_DAYS,
      total: projects.length,
      live: live.length,
      overdue: live.filter(p => p.overdue).length,
      on_hold: live.filter(p => p.on_hold).length,
      completed: projects.length - live.length,
      by_role: Object.values(byRole).sort((a, b) => b.overdue - a.overdue || b.avg_days - a.avg_days),
      ground,
      delay_by_reason: Object.values(byReason).sort((a, b) => b.days - a.days),
      delay_by_party: Object.values(byParty).sort((a, b) => b.days - a.days),
      projects: projects.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.days_in_stage - a.days_in_stage),
    });
  }

  // --- ledger -------------------------------------------------------------------------------
  // --- tender initiation --------------------------------------------------------------------
  if (pathname === '/api/tenders' && method === 'GET') {
    const user = getSession(parseCookies(req.headers.cookie)[COOKIE]);
    const tenders = listTenders(db).map(t => ({
      ...t,
      available_actions: user ? tenderActionsFor(t.status, user.role) : [],
    }));
    return json(res, 200, { tenders });
  }

  if (pathname === '/api/tenders' && method === 'POST') {
    const user = requireSession(req);
    const body = await readJsonBody(req);
    const result = createPackage(db, {
      role: user.role,                      // NOT body.role
      actorUser: actorId(user.username),
      ...body,
    });
    return json(res, 201, {
      tender: result.tender,
      entry: { seq: result.entry.seq, hash: result.entry.hash, prev_hash: result.entry.prev_hash },
    });
  }

  const tenderDetail = pathname.match(/^\/api\/tenders\/([0-9a-f-]{36})$/);
  if (tenderDetail && method === 'GET') {
    const user = getSession(parseCookies(req.headers.cookie)[COOKIE]);
    const tender = decorateTender(db, getTender(db, tenderDetail[1]));
    return json(res, 200, {
      tender,
      events: tenderEvents(db, tender.id),
      available_actions: user ? tenderActionsFor(tender.status, user.role) : [],
      acting_as: user ?? null,
    });
  }

  if (tenderDetail && method === 'PATCH') {
    const user = requireSession(req);
    const body = await readJsonBody(req);
    const result = revisePackage(db, {
      tenderId: tenderDetail[1], role: user.role, actorUser: actorId(user.username), patch: body,
    });
    return json(res, 200, {
      tender: result.tender,
      entry: result.entry ? { seq: result.entry.seq, hash: result.entry.hash } : null,
    });
  }

  const tenderAction = pathname.match(/^\/api\/tenders\/([0-9a-f-]{36})\/action$/);
  if (tenderAction && method === 'POST') {
    const user = requireSession(req);
    const body = await readJsonBody(req);
    const result = actOnTender(db, {
      tenderId: tenderAction[1],
      role: user.role,                      // NOT body.role
      actorUser: actorId(user.username),
      action: body.action,
      comment: body.comment ?? '',
      budget_head: body.budget_head ?? '',
      bid_due_date: body.bid_due_date ?? null,
      dsc_pin: body.dsc_pin ?? null,
      contractor: body.contractor ?? '',
    });
    return json(res, 200, {
      tender: result.tender,
      entry: { seq: result.entry.seq, hash: result.entry.hash, prev_hash: result.entry.prev_hash },
      moved_to: result.transition.to,
      project: result.project ? decorate(db, result.project) : null,
      acting_as: user,
    });
  }

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
      chain_valid: chain.valid, stale_schema: chain.stale_schema, schema: chain.schema,
      length: chain.length, tip: chain.tip,
      first_break: chain.first_break, breaks: chain.breaks,
      anchors, entries: chain.entries,
    });
  }

  return json(res, 404, { error: 'No such endpoint', endpoint: pathname });
}
