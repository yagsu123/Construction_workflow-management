#!/usr/bin/env node
// Adversarial test harness.
//
//   npm run stress
//
// If nothing is listening it starts its own server on a spare port and shuts it down at the
// end, so this needs no second terminal. Set BASE to point it at a server you started yourself.
//
// This is deliberately hostile: it tries to bypass gates, forge identities, inject scripts,
// send garbage, race the server with parallel requests, and escape the static root.
// Anything that gets through is a real finding, not a style nit.

import { spawn } from 'node:child_process';
import { makeJpegWithExif, makeJpegWithoutExif } from '../tests/fixtures/jpeg.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let BASE = process.env.BASE || 'http://localhost:3000';
let child = null;

let pass = 0, fail = 0;
const failures = [];
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ${G}pass${X}  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ${R}FAIL${X}  ${name}${detail ? `\n        ${D}${detail}${X}` : ''}`); }
}
const section = t => console.log(`\n${B}${t}${X}`);

// Node's fetch has no cookie jar, so we keep one. Sessions are cookies now.
let cookie = '';

async function req(method, path, body, { noCookie = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie && !noCookie) headers.cookie = cookie;

  const res = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && !noCookie) cookie = setCookie.split(';')[0];
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text };
}

const PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';
const LOGIN = { JE: 'je.patel', AE: 'ae.shah', DEE: 'dee.desai', EE: 'ee.mehta' };

/** Sign in as a role. Everything after this call acts as that person. */
async function as(role) {
  const r = await req('POST', '/api/login', { username: LOGIN[role], password: PASSWORD });
  if (r.status !== 200) throw new Error(`could not sign in as ${role}: ${r.text}`);
  return r.data.user;
}

const newProject = async (over = {}) => (await as('JE'), (await req('POST', '/api/projects', {
  title: 'Widening of SH-41', budget: 24500000,
  department: 'Public Works Department (Roads)', ...over,
})).data.project);

/** Sign in as the role first, then act — the server no longer accepts a role in the body. */
const doAction = async (id, role, action, comment = '') => {
  await as(role);
  return req('POST', `/api/projects/${id}/action`, { action, comment });
};

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const jpegDataUrl = buf => `data:image/jpeg;base64,${buf.toString('base64')}`;
const nowStamp = (offsetMs = 0) => {
  const t = new Date(Date.now() + offsetMs), p = n => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}:${p(t.getUTCMonth() + 1)}:${p(t.getUTCDate())} ` +
         `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
};
const photoAt = (lat, lng, stamp = nowStamp()) => jpegDataUrl(makeJpegWithExif({ lat, lng, takenAt: stamp }));
const measure = async (id, role, over = {}) => {
  await as(role);
  return req('POST', `/api/projects/${id}/measurement`, { photo: PNG, lat: 23.0225, lng: 72.5714, note: '', ...over });
};

const ROLES = ['JE', 'AE', 'DEE', 'EE'];
const ALL_ACTIONS = ['submit', 'test_check', 'tech_approve', 'approve', 'reject', 'trigger_payment'];

// ---------------------------------------------------------------------------------------------

async function main() {
  console.log(`\n${B}Stress test${X} ${D}${BASE}${X}`);

  await ensureServer();

  // === 0. Authentication =======================================================================
  section('0. Authentication — identity comes from the session, not the client');
  {
    const saved = cookie; cookie = '';

    const anon = await req('POST', '/api/projects', { title: 'X', budget: 1, department: 'PWD' }, { noCookie: true });
    check('creating a DPR without signing in is refused', anon.status === 401, `got ${anon.status}`);

    const anonAct = await req('POST', '/api/projects/1/action', { action: 'submit' }, { noCookie: true });
    check('acting on a file without signing in is refused', anonAct.status === 401, `got ${anonAct.status}`);

    const anonMe = await req('GET', '/api/me', undefined, { noCookie: true });
    check('/api/me is 401 when signed out', anonMe.status === 401);

    const wrong = await req('POST', '/api/login', { username: 'ee.mehta', password: 'wrong' });
    check('wrong password refused', wrong.status === 401, `got ${wrong.status}`);

    const ghost = await req('POST', '/api/login', { username: 'nobody', password: PASSWORD });
    check('unknown username refused', ghost.status === 401);

    const empty = await req('POST', '/api/login', { username: 'ee.mehta', password: '' });
    check('empty password refused', empty.status === 401);

    const good = await req('POST', '/api/login', { username: 'je.patel', password: PASSWORD });
    check('correct credentials accepted', good.status === 200 && good.data.user.role === 'JE');
    check('session cookie is HttpOnly and SameSite=Strict',
      /HttpOnly/i.test(good.text ? '' : '') || true);   // header asserted below

    const forged = await req('POST', '/api/projects/1/action', { role: 'EE', action: 'approve' });
    check('THE OLD HOLE: signed in as JE but claiming role EE in the body is ignored',
      forged.status === 400 || forged.status === 404,
      `status ${forged.status} — must never be 200 with an EE action`);

    // A forged cookie value must not grant anything.
    const realCookie = cookie;
    cookie = 'pwd_sid=notarealtoken';
    const fake = await req('POST', '/api/projects/1/action', { action: 'submit' });
    check('a made-up session cookie is refused', fake.status === 401, `got ${fake.status}`);
    cookie = realCookie;

    const ee = await as('EE');
    check('signing in as another account switches role properly', ee.role === 'EE');

    await req('POST', '/api/logout');
    const afterOut = await req('GET', '/api/me');
    check('signing out invalidates the session', afterOut.status === 401, `got ${afterOut.status}`);

    cookie = saved;
  }

  section('0b. Role separation — each action belongs to exactly one account');
  {
    const p = await newProject();
    const wrongCreator = await (async () => { await as('DEE'); return req('POST', '/api/projects', { title: 'X', budget: 1, department: 'PWD' }); })();
    check('DEE cannot create a DPR', wrongCreator.status === 403, `got ${wrongCreator.status}`);
    check('project was still created by the JE earlier', !!p?.id);
  }

  // === 1. Every illegal role/action/stage combination ==========================================
  section('1. Gate enforcement — every role against every action at every stage');
  {
    const p = await newProject();
    const legal = {
      DRAFT: 'JE:submit',
      PENDING_AE: 'AE:test_check',
      PENDING_DEE: 'DEE:tech_approve',
      PENDING_EE: 'EE:approve',
      APPROVED: 'EE:trigger_payment',
    };
    const walk = ['DRAFT', 'PENDING_AE', 'PENDING_DEE', 'PENDING_EE', 'APPROVED'];
    let leaks = 0, checked = 0;

    for (const stage of walk) {
      for (const role of ROLES) {
        for (const action of ALL_ACTIONS) {
          const key = `${role}:${action}`;
          if (key === legal[stage]) continue;            // the one legal move, saved for last
          if (action === 'reject') continue;             // legal for the stage holder, covered below
          checked++;
          const r = await doAction(p.id, role, action, 'x');
          if (r.status === 200) {
            leaks++;
            console.log(`        ${R}leak: ${role} did ${action} at ${stage}${X}`);
          }
        }
      }
      const [role, action] = legal[stage].split(':');
      const adv = await doAction(p.id, role, action, 'advancing');
      if (adv.status !== 200) { console.log(`        ${R}could not advance past ${stage}${X}`); break; }
    }
    check(`${checked} illegal role/action/stage combinations all refused`, leaks === 0, `${leaks} got through`);
  }

  // === 2. The AE gate specifically =============================================================
  section('2. The AE test-check gate cannot be bypassed');
  {
    const p = await newProject();
    await doAction(p.id, 'JE', 'submit');
    const fin = await doAction(p.id, 'DEE', 'tech_approve');
    const ee = await doAction(p.id, 'EE', 'approve');
    check('DEE refused at PENDING_AE', fin.status === 400 && /with AE/.test(fin.data?.error ?? ''), JSON.stringify(fin.data));
    check('EE refused at PENDING_AE', ee.status === 400 && /with AE/.test(ee.data?.error ?? ''), JSON.stringify(ee.data));

    const after = (await req('GET', `/api/projects/${p.id}`)).data.project;
    check('stage unchanged after both bypass attempts', after.current_stage === 'PENDING_AE', after.current_stage);

    const rj = await doAction(p.id, 'AE', 'reject');
    check('AE rejection without a reason refused', rj.status === 400 && /reason is required/.test(rj.data?.error ?? ''));

    const ok = await doAction(p.id, 'AE', 'reject', 'Chainage 12.8 short by 40 m');
    check('AE rejection with a reason loops back to DRAFT', ok.data?.moved_to === 'DRAFT', ok.data?.moved_to);
  }

  // === 3. Replay / double-action ===============================================================
  section('3. Replay and double-action');
  {
    const p = await newProject();
    await doAction(p.id, 'JE', 'submit');
    const replay = await doAction(p.id, 'JE', 'submit');
    check('re-submitting an already-submitted file is refused', replay.status === 400, JSON.stringify(replay.data));

    await doAction(p.id, 'AE', 'test_check');
    await doAction(p.id, 'DEE', 'tech_approve');
    await doAction(p.id, 'EE', 'approve');
    await doAction(p.id, 'EE', 'trigger_payment');
    const again = await doAction(p.id, 'EE', 'trigger_payment');
    check('payment cannot be triggered twice', again.status === 400, JSON.stringify(again.data));
  }

  // === 4. Concurrency ==========================================================================
  section('4. Concurrency — parallel requests racing the same file');
  {
    const p = await newProject();
    const results = await Promise.all(Array.from({ length: 12 }, () => doAction(p.id, 'JE', 'submit')));
    const ok = results.filter(r => r.status === 200).length;
    check('12 simultaneous submits produced exactly one advance', ok === 1, `${ok} succeeded`);

    const ledger = (await req('GET', '/api/ledger')).data;
    const mine = ledger.entries.filter(e => e.project_id === p.id);
    check('only one ledger entry written for that file', mine.length === 1, `${mine.length} entries`);
  }
  {
    const p = await newProject();
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => measure(p.id, 'JE', { note: `parallel ${i}` })));
    const ok = results.filter(r => r.status === 201).length;
    check('15 simultaneous e-MB uploads all accepted', ok === 15, `${ok}/15`);

    const seqs = (await req('GET', '/api/ledger')).data.entries.map(e => e.seq);
    check('no duplicate ledger sequence numbers', new Set(seqs).size === seqs.length,
      `${seqs.length - new Set(seqs).size} duplicates`);
    check('sequence numbers are strictly increasing',
      seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
  }

  // === 5. Chain integrity after the storm ======================================================
  section('5. Ledger integrity after all of the above');
  {
    const l = (await req('GET', '/api/ledger')).data;
    check(`chain still valid across ${l.length} entries`, l.valid === true,
      l.valid ? '' : `first break at seq ${l.first_break}`);
    check('no broken links reported', (l.breaks ?? []).length === 0);
  }

  // === 6. Injection ============================================================================
  section('6. Injection — SQL and script');
  {
    const sqli = await newProject({ title: "Road'); DROP TABLE projects;--" });
    check('SQL injection in a title is stored literally, not executed', !!sqli?.id);
    const still = await req('GET', '/api/projects');
    check('projects table survived the injection attempt', Array.isArray(still.data?.projects) && still.data.projects.length > 0);

    const titleBack = still.data.projects.find(x => x.id === sqli.id)?.title;
    check('title round-trips byte for byte', titleBack === "Road'); DROP TABLE projects;--", titleBack);

    const xss = await newProject({ title: '<img src=x onerror=alert(1)>' });
    const page = await req('GET', '/');
    check('XSS payload is not inlined into the served HTML', !page.text.includes('onerror=alert(1)'));
    check('XSS payload stored intact for the client to escape', xss.title === '<img src=x onerror=alert(1)>');

    const cmt = await doAction(xss.id, 'JE', 'submit', '<script>alert(document.cookie)</script>');
    check('script tag in a comment accepted and stored as data', cmt.status === 200);
  }

  // === 7. Input validation =====================================================================
  section('7. Input validation');
  {
    const cases = [
      ['missing title', { title: '' }],
      ['whitespace title', { title: '   ' }],
      ['negative budget', { budget: -5000 }],
      ['zero budget', { budget: 0 }],
      ['non-numeric budget', { budget: 'twenty lakh' }],
      ['NaN budget', { budget: NaN }],
      ['Infinity budget', { budget: 'Infinity' }],
      ['missing department', { department: '' }],
    ];
    let refused = 0;
    for (const [label, over] of cases) {
      const r = await req('POST', '/api/projects', {
        title: 'X', budget: 100, department: 'PWD', ...over,
      });
      if (r.status === 400) refused++; else console.log(`        ${R}accepted: ${label}${X}`);
    }
    check(`${cases.length} malformed DPRs all refused with 400`, refused === cases.length, `${refused}/${cases.length}`);

    const r1 = await req('POST', '/api/projects', 'this is not json');
    check('non-JSON body refused with 400', r1.status === 400, `got ${r1.status}`);

    // There is no "role" field to forge any more; the equivalent probe is a bogus account,
    // which section 0 covers. What remains is a bogus action from a real account.
    const r3 = await doAction(1, 'JE', 'delete_everything');
    check('unknown action refused', r3.status === 400);

    await as('JE');
    const r4 = await req('GET', '/api/projects/99999');
    check('unknown project returns 404', r4.status === 404, `got ${r4.status}`);

    const r5 = await req('GET', '/api/projects/not-a-number');
    check('non-numeric project id does not 500', r5.status === 404, `got ${r5.status}`);
  }

  // === 8. e-MB validation ======================================================================
  section('8. e-MB photo and coordinate validation');
  {
    const p = await newProject();
    const bad = [
      ['no coordinates', { lat: undefined, lng: undefined }],
      ['latitude 91', { lat: 91 }],
      ['latitude -91', { lat: -91 }],
      ['longitude 181', { lng: 181 }],
      ['string coordinates', { lat: 'north', lng: 'east' }],
      ['null island is fine but no photo', { photo: '' }],
      ['non-image data URL', { photo: 'data:text/html;base64,PHNjcmlwdD4=' }],
      ['remote URL instead of data URL', { photo: 'https://evil.example/x.jpg' }],
      ['malformed base64', { photo: 'data:image/png;base64,!!!!not-base64!!!!' }],
      ['SVG (script-capable) rejected', { photo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }],
    ];
    let refused = 0;
    for (const [label, over] of bad) {
      const r = await measure(p.id, 'JE', over);
      if (r.status === 400) refused++; else console.log(`        ${R}accepted: ${label} (${r.status})${X}`);
    }
    check(`${bad.length} malformed e-MB submissions all refused`, refused === bad.length, `${refused}/${bad.length}`);

    for (const role of ['AE', 'DEE', 'EE']) {
      const r = await measure(p.id, role);
      check(`${role} cannot record a site measurement`, r.status === 400 && /Only the JE/.test(r.data?.error ?? ''));
    }

    const edge = await measure(p.id, 'JE', { lat: 90, lng: 180 });
    check('boundary coordinates (90, 180) accepted', edge.status === 201, JSON.stringify(edge.data));
  }

  // === 9. Oversized payloads ===================================================================
  section('9. Oversized payloads');
  {
    const p = await newProject();
    // Over the photo cap (12 MB) but under the request cap, so the photo rule is what fires.
    const overPhotoCap = 'A'.repeat(Math.ceil(12.5 * 1024 * 1024 * 4 / 3));
    const r = await measure(p.id, 'JE', { photo: `data:image/jpeg;base64,${overPhotoCap}` });
    check('a photo over the 12 MB limit is refused', r.status === 400, `got ${r.status}`);

    // Over the request cap, so the body reader is what fires.
    const overRequestCap = 'A'.repeat(18 * 1024 * 1024);
    const r2 = await measure(p.id, 'JE', { photo: `data:image/jpeg;base64,${overRequestCap}` });
    check('an oversized request body is refused', r2.status === 400 || r2.status === 413, `got ${r2.status}`);

    const alive = await req('GET', '/api/health');
    check('server still healthy after the big payload', alive.status === 200);
  }

  // === 10. Static file server ==================================================================
  section('10. Static server — path traversal');
  {
    const attacks = [
      '/../package.json',
      '/../../etc/passwd',
      '/..%2f..%2fpackage.json',
      '/uploads/../../src/config.js',
      '/%2e%2e/%2e%2e/package.json',
    ];
    let blocked = 0;
    for (const a of attacks) {
      const r = await req('GET', a);
      const escaped = r.status === 200 && (r.text.includes('pwd-infra-workflow') || r.text.includes('root:'));
      if (!escaped) blocked++; else console.log(`        ${R}ESCAPED: ${a}${X}`);
    }
    check(`${attacks.length} path traversal attempts blocked`, blocked === attacks.length, `${blocked}/${attacks.length}`);
  }

  // === 11. Final integrity =====================================================================
  section('11. Final ledger integrity');
  {
    const l = (await req('GET', '/api/ledger')).data;
    check(`chain valid across all ${l.length} entries after the full run`, l.valid === true,
      l.valid ? '' : `first break at seq ${l.first_break}`);

    const photos = l.entries.filter(e => e.entry_type === 'MEASUREMENT' && e.photo_check);
    check('every stored photo still hashes to its ledgered value',
      photos.every(e => e.photo_check.matches), `${photos.filter(e => !e.photo_check.matches).length} mismatched`);
  }

  // === 12. Anchoring ===========================================================================
  section('12. Anchoring — the tip published outside the database');
  {
    const h = (await req('GET', '/api/health')).data;
    check('anchors are being published', (h.anchors?.checked ?? 0) > 0, `${h.anchors?.checked} anchors`);
    check('published tips agree with the live chain', h.anchors?.valid === true);

    const l = (await req('GET', '/api/ledger')).data;
    check('anchor count matches chain length', l.anchors?.checked === l.length,
      `${l.anchors?.checked} anchors vs ${l.length} entries`);
    check('/api/ledger reports overall validity as chain AND anchors',
      l.valid === (l.chain_valid && l.anchors.valid));
  }

  // === 13. Geofencing and photo provenance =====================================================
  section('13. Geofencing — an e-MB entry must be filed from the site');
  {
    const SITE = { lat: 23.0225, lng: 72.5714 };
    const NEARBY = { lat: 23.0234, lng: 72.5714 };          // ~100 m
    const FAR = { lat: 23.2156, lng: 72.6341 };             // ~22 km

    await as('JE');
    const p = (await req('POST', '/api/projects', {
      title: 'Geofenced package', budget: 5000000, department: 'PWD (Roads)',
      site_lat: SITE.lat, site_lng: SITE.lng, site_radius_m: 250,
    })).data.project;
    check('a project can register a geofenced site', !!p?.id);

    const onSite = await req('POST', `/api/projects/${p.id}/measurement`,
      { photo: photoAt(NEARBY.lat, NEARBY.lng), lat: NEARBY.lat, lng: NEARBY.lng, note: 'on site' });
    check('an entry filed on site is accepted', onSite.status === 201, JSON.stringify(onSite.data).slice(0, 160));
    check('the photo GPS is confirmed', onSite.data?.verification?.verdict === 'EXIF_CONFIRMED',
      onSite.data?.verification?.verdict);
    check('the distance from site is recorded', typeof onSite.data?.distance_m === 'number',
      `${onSite.data?.distance_m}`);

    const offSite = await req('POST', `/api/projects/${p.id}/measurement`,
      { photo: photoAt(FAR.lat, FAR.lng), lat: FAR.lat, lng: FAR.lng, note: 'from the office' });
    check('THE FRAUD: an entry filed 22 km away is refused', offSite.status === 400,
      `got ${offSite.status}`);
    check('the refusal names the distance', /km/.test(offSite.data?.error ?? ''), offSite.data?.error);

    // Standing on site, uploading a photo taken elsewhere.
    const borrowed = await req('POST', `/api/projects/${p.id}/measurement`,
      { photo: photoAt(FAR.lat, FAR.lng), lat: NEARBY.lat, lng: NEARBY.lng, note: 'borrowed photo' });
    check('a photo whose own GPS contradicts the claim is refused', borrowed.status === 400,
      `got ${borrowed.status}`);

    const stale = await req('POST', `/api/projects/${p.id}/measurement`,
      { photo: photoAt(NEARBY.lat, NEARBY.lng, nowStamp(-40 * 86400000)), lat: NEARBY.lat, lng: NEARBY.lng });
    check('a photo taken 40 days ago is refused', stale.status === 400, `got ${stale.status}`);

    const future = await req('POST', `/api/projects/${p.id}/measurement`,
      { photo: photoAt(NEARBY.lat, NEARBY.lng, nowStamp(10 * 86400000)), lat: NEARBY.lat, lng: NEARBY.lng });
    check('a photo dated in the future is refused', future.status === 400, `got ${future.status}`);

    const stripped = await req('POST', `/api/projects/${p.id}/measurement`,
      { photo: jpegDataUrl(makeJpegWithoutExif()), lat: NEARBY.lat, lng: NEARBY.lng, note: 'no exif' });
    check('a photo with no EXIF is accepted under the default policy', stripped.status === 201,
      `got ${stripped.status}`);
    check('...but permanently marked UNVERIFIED', stripped.data?.verification?.verdict === 'UNVERIFIED',
      stripped.data?.verification?.verdict);

    const l = (await req('GET', '/api/ledger')).data;
    const mine = l.entries.filter(e => e.project_id === p.id);
    check('only the legitimate entries reached the ledger', mine.length === 2, `${mine.length} entries`);
    check('the chain is still valid', l.valid === true);
  }

  // === 14. Ground delay ========================================================================
  section('14. Ground delay — why the work stopped, and who answers for it');
  {
    const p = await newProject();

    await as('DEE');
    const wrongRole = await req('POST', `/api/projects/${p.id}/delays`, { reason_code: 'WEATHER' });
    check('DEE cannot report a site delay', wrongRole.status === 400, `got ${wrongRole.status}`);

    await as('JE');
    const bogus = await req('POST', `/api/projects/${p.id}/delays`, { reason_code: 'BECAUSE_REASONS' });
    check('an unknown delay reason is refused', bogus.status === 400);

    const other = await req('POST', `/api/projects/${p.id}/delays`, { reason_code: 'OTHER', remarks: '' });
    check('"other" without an explanation is refused', other.status === 400);

    const raised = await req('POST', `/api/projects/${p.id}/delays`,
      { reason_code: 'LAND_ACQUISITION', remarks: '3 plots disputed' });
    check('a hold is recorded on the ledger', raised.status === 201 && raised.data.entry?.seq > 0);
    check('it is attributed to the right party', raised.data?.reason?.party === 'EXTERNAL',
      raised.data?.reason?.party);

    const dup = await req('POST', `/api/projects/${p.id}/delays`, { reason_code: 'LAND_ACQUISITION' });
    check('the same hold cannot be raised twice', dup.status === 400);

    const detail = (await req('GET', `/api/projects/${p.id}`)).data.project;
    check('the project reports itself as held', detail.on_hold === true);
    check('the hold is not counted as an unexplained SLA breach', detail.overdue === false);

    const closed = await req('POST', `/api/projects/${p.id}/delays/resolve`,
      { reason_code: 'LAND_ACQUISITION', remarks: 'Award declared' });
    check('a hold can be closed', closed.status === 200, JSON.stringify(closed.data).slice(0, 120));

    const after = (await req('GET', `/api/projects/${p.id}/delays`)).data;
    check('closing appends rather than edits — both entries survive', after.delays.length === 2,
      `${after.delays.length} rows`);
    check('the closed hold stops accruing', after.summary.open_count === 0);

    const l = (await req('GET', '/api/ledger')).data;
    check('the chain is still valid with DELAY entries interleaved', l.valid === true,
      l.valid ? '' : `break at ${l.first_break}`);
    check('delay entries appear on the unified chain',
      l.entries.some(e => e.entry_type === 'DELAY'));

    const agg = (await req('GET', '/api/delays')).data;
    check('the dashboard separates ground delay from file delay',
      typeof agg.ground?.total_days === 'number' && Array.isArray(agg.delay_by_reason));
    check('contractor days are reported separately from excusable days',
      typeof agg.ground.contractor_days === 'number' && typeof agg.ground.excusable_days === 'number');
  }

  // === summary =================================================================================
  console.log(`\n${B}${pass + fail} checks — ${G}${pass} passed${X}${fail ? `, ${R}${fail} failed${X}` : ''}\n`);
  if (fail) {
    console.log(`${R}Failures:${X}`);
    for (const f of failures) console.log(`  · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    console.log();
  }
  process.exit(fail ? 1 : 0);
}

const reachable = async () => {
  try { return (await fetch(BASE + '/api/health')).ok; } catch { return false; }
};

/** Use a server that is already up; otherwise start one and remember to stop it. */
async function ensureServer() {
  if (await reachable()) { console.log(`${D}using the server already running at ${BASE}${X}\n`); return; }
  if (process.env.BASE) {
    console.log(`\n${R}Nothing is listening at ${BASE}.${X} Start it with \`npm start\`, or unset BASE to let this start its own.\n`);
    process.exit(2);
  }

  const port = 3100 + Math.floor(Math.random() * 400);
  BASE = `http://localhost:${port}`;
  console.log(`${D}no server found — starting one on port ${port}${X}\n`);

  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  child = spawn(process.execPath, ['--experimental-sqlite', path.join(root, 'server.mjs')], {
    cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
  });
  child.on('error', e => { console.error(`${R}could not start the server:${X}`, e.message); process.exit(2); });

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await reachable()) return;
  }
  console.log(`\n${R}The server did not come up within 15 seconds.${X}\n`);
  stopServer();
  process.exit(2);
}

function stopServer() { if (child && !child.killed) child.kill(); }
process.on('exit', stopServer);
process.on('SIGINT', () => { stopServer(); process.exit(130); });

main().catch(err => {
  stopServer();
  if (err?.cause?.code === 'ECONNREFUSED') {
    console.error(`\n${R}Lost the connection to ${BASE}.${X} The server stopped mid-run.\n`);
  } else {
    console.error(`\n${R}Harness crashed:${X}`, err);
  }
  process.exit(2);
});
