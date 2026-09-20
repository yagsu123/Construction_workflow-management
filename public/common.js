// Shared front-end helpers. No framework, no build step.

export const GENESIS = '0'.repeat(64);

// --- who you are ----------------------------------------------------------------------------
// The role used to come from a dropdown, which meant the client decided its own permissions.
// It now comes from the server, from a session that required a password. There is no setter.
let currentUser = null;

export const getUser = () => currentUser;
export const getRole = () => currentUser?.role ?? null;

/** Load the signed-in user, or send the visitor to the login page. */
export async function requireUser() {
  const res = await fetch('/api/me');
  if (res.status === 401) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    return new Promise(() => {});          // navigation in flight; never resolve
  }
  currentUser = (await res.json()).user;
  return currentUser;
}

export async function signOut() {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
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
const NAV = [
  ['/', 'Projects'],
  ['/ledger.html', 'Ledger'],
  ['/dashboard.html', 'Delay dashboard'],
];

/** Render the shared top bar. Identity is displayed, not chosen. */
export function mountHeader(current) {
  const user = currentUser;
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
    <div class="whoami">
      <div>
        <span class="pill">${esc(user?.role ?? '—')}</span>
        <strong>${esc(user?.name ?? 'Not signed in')}</strong>
        <div class="meta">${esc(user?.designation ?? '')}</div>
      </div>
      <button id="signout" type="button">Sign out</button>
    </div>`;
  document.body.prepend(header);
  header.querySelector('#signout').addEventListener('click', signOut);
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
