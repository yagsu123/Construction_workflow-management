#!/usr/bin/env node
// Adversarial test harness. Runs against a LIVE server over real HTTP.
//
//   npm start                 # terminal 1
//   npm run stress            # terminal 2
//
// This is deliberately hostile: it tries to bypass gates, inject scripts, send
// garbage, race the server with parallel requests, and escape the static root.
// Anything that gets through is a real finding, not a style nit.

const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0, fail = 0;
const failures = [];
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ${G}pass${X}  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ${R}FAIL${X}  ${name}${detail ? `\n        ${D}${detail}${X}` : ''}`); }
}
const section = t => console.log(`\n${B}${t}${X}`);

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text };
}

const newProject = async (over = {}) => (await req('POST', '/api/projects', {
  title: 'Widening of SH-41', budget: 24500000,
  department: 'Public Works Department (Roads)', ...over,
})).data.project;

const doAction = (id, role, action, comment = '') =>
  req('POST', `/api/projects/${id}/action`, { role, action, comment });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const measure = (id, role, over = {}) =>
  req('POST', `/api/projects/${id}/measurement`, { role, photo: PNG, lat: 23.0225, lng: 72.5714, note: '', ...over });

const ROLES = ['JE', 'AE', 'FIN', 'EE'];
const ALL_ACTIONS = ['submit', 'test_check', 'verify', 'approve', 'reject', 'trigger_payment'];

// ---------------------------------------------------------------------------------------------

async function main() {
  console.log(`\n${B}Stress test${X} ${D}${BASE}${X}`);

  const health = await req('GET', '/api/health');
  if (health.status !== 200) {
    console.log(`\n${R}Server is not responding at ${BASE}. Start it with \`npm start\` first.${X}\n`);
    process.exit(2);
  }

  // === 1. Every illegal role/action/stage combination ==========================================
  section('1. Gate enforcement — every role against every action at every stage');
  {
    const p = await newProject();
    const legal = {
      DRAFT: 'JE:submit',
      PENDING_AE: 'AE:test_check',
      PENDING_FINANCE: 'FIN:verify',
      PENDING_EE: 'EE:approve',
      APPROVED: 'EE:trigger_payment',
    };
    const walk = ['DRAFT', 'PENDING_AE', 'PENDING_FINANCE', 'PENDING_EE', 'APPROVED'];
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
    const fin = await doAction(p.id, 'FIN', 'verify');
    const ee = await doAction(p.id, 'EE', 'approve');
    check('Finance refused at PENDING_AE', fin.status === 400 && /with AE/.test(fin.data?.error ?? ''), JSON.stringify(fin.data));
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
    await doAction(p.id, 'FIN', 'verify');
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

    const r2 = await doAction(1, 'SUPERUSER', 'approve');
    check('unknown role refused', r2.status === 400 && /Unknown role/.test(r2.data?.error ?? ''));

    const r3 = await doAction(1, 'JE', 'delete_everything');
    check('unknown action refused', r3.status === 400);

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

    for (const role of ['AE', 'FIN', 'EE']) {
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
    const big = 'A'.repeat(6 * 1024 * 1024);
    const r = await measure(p.id, 'JE', { photo: `data:image/png;base64,${big}` });
    check('oversized photo refused, server survives', r.status === 400 || r.status === 413, `got ${r.status}`);

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

  // === summary =================================================================================
  console.log(`\n${B}${pass + fail} checks — ${G}${pass} passed${X}${fail ? `, ${R}${fail} failed${X}` : ''}\n`);
  if (fail) {
    console.log(`${R}Failures:${X}`);
    for (const f of failures) console.log(`  · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    console.log();
  }
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(`\n${R}Harness crashed:${X}`, err); process.exit(2); });
