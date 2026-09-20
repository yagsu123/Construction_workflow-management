// Shared front-end helpers. No framework, no build step.

export const GENESIS = '0'.repeat(64);

// --- current role (a demo convenience, not auth) -------------------------------------------
const ROLE_KEY = 'pwd.role';

export function getRole() {
  try { return localStorage.getItem(ROLE_KEY) || 'JE'; } catch { return 'JE'; }
}
export function setRole(role) {
  try { localStorage.setItem(ROLE_KEY, role); } catch { /* private mode — role resets on reload */ }
}

// --- fetch ----------------------------------------------------------------------------------
export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// --- formatting -------------------------------------------------------------------------------
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const shortHash = h => (h === GENESIS ? 'genesis' : `${String(h).slice(0, 8)}…${String(h).slice(-4)}`);

export function money(n) {
  const v = Number(n);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN')}`;
}

export function when(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ago(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export const STATUS_TONE = {
  SUBMITTED: '', TEST_CHECKED: 'ok', VERIFIED: 'ok', APPROVED: 'ok',
  PAYMENT_TRIGGERED: 'ok', REJECTED: 'danger',
};

// --- header ------------------------------------------------------------------------------------
// Ledger viewer and delay dashboard land in Phase 4.
const NAV = [
  ['/', 'Projects'],
];

/** Render the shared top bar, including the role switcher. Reloads the page on role change. */
export function mountHeader(current, { onRoleChange } = {}) {
  const role = getRole();
  const header = document.createElement('header');
  header.className = 'topbar';
  header.innerHTML = `
    <div class="brand">PWD Infrastructure Workflow
      <small>Digital MB approval &middot; tamper-evident ledger</small>
    </div>
    <div class="spacer"></div>
    <nav class="topnav">
      ${NAV.map(([href, label]) =>
        `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
    </nav>
    <div class="rolebox">
      <label for="roleSelect">Acting as</label>
      <select id="roleSelect">
        <option value="JE"${role === 'JE' ? ' selected' : ''}>JE — Junior Engineer</option>
        <option value="AE"${role === 'AE' ? ' selected' : ''}>AE — Assistant Engineer / SDO</option>
        <option value="FIN"${role === 'FIN' ? ' selected' : ''}>FIN — Finance / Accounts</option>
        <option value="EE"${role === 'EE' ? ' selected' : ''}>EE — Executive Engineer</option>
      </select>
    </div>`;
  document.body.prepend(header);

  header.querySelector('#roleSelect').addEventListener('change', e => {
    setRole(e.target.value);
    if (onRoleChange) onRoleChange(e.target.value);
    else location.reload();
  });
  return header;
}

export function toast(message, tone = '') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast show ${tone}`;
  el.textContent = message;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 4000);
}
