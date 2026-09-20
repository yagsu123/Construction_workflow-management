// Authentication.
//
// The role switcher was a demo convenience: the client told the server which role it was, and
// the server believed it. Anyone with curl could approve their own bill as the EE. Roles are
// now derived from a signed-in session and the `role` field in a request body is ignored
// entirely - see requireSession() in api.js.
//
// Passwords are scrypt-hashed with a per-user salt and compared in constant time. Sessions are
// opaque 256-bit tokens in an httpOnly cookie. This is demo-scale (in-memory sessions, fixed
// accounts, no password reset) but it is not fake: there is no path from the browser to a role
// that does not go through a password.

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // one working day
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';

/** Fixed departmental accounts. One person per role, which is what a division office looks like. */
const ACCOUNTS = [
  { username: 'contractor.ltd', name: 'Contractor', role: 'CONTRACTOR', designation: 'Primary Contractor' },
  { username: 'je.patel',  name: 'R. Patel',  role: 'JE',  designation: 'Junior Engineer, Sub-Division II' },
  { username: 'ae.shah',   name: 'S. Shah',   role: 'AE',  designation: 'Assistant Engineer / SDO, Sub-Division II' },
  { username: 'dee.desai', name: 'K. Desai',  role: 'DEE', designation: 'Deputy Executive Engineer, Sub-Division II' },
  { username: 'ee.mehta',  name: 'A. Mehta',  role: 'EE',  designation: 'Executive Engineer, Ahmedabad Division' },
];

function hash(password, salt) {
  return scryptSync(password, salt, 64);
}

// Built once at startup. No plaintext password is kept.
const USERS = new Map(ACCOUNTS.map(a => {
  const salt = randomBytes(16);
  return [a.username, { ...a, salt, hash: hash(DEMO_PASSWORD, salt) }];
}));

export const DEMO_ACCOUNTS = ACCOUNTS.map(a => ({ ...a }));
export const demoPassword = () => DEMO_PASSWORD;

/** @returns {{username,name,role,designation}|null} */
export function verifyCredentials(username, password) {
  const user = USERS.get(String(username || '').trim().toLowerCase());
  // Hash regardless, so a wrong username and a wrong password cost the same time.
  const salt = user?.salt ?? Buffer.alloc(16);
  const candidate = hash(String(password ?? ''), salt);
  if (!user) return null;
  if (candidate.length !== user.hash.length) return null;
  if (!timingSafeEqual(candidate, user.hash)) return null;
  return { username: user.username, name: user.name, role: user.role, designation: user.designation };
}

// --- sessions ---------------------------------------------------------------------------------
const sessions = new Map();   // token -> { username, expires }

export function createSession(username) {
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  const user = USERS.get(s.username);
  if (!user) return null;
  return { username: user.username, name: user.name, role: user.role, designation: user.designation };
}

export function destroySession(token) {
  if (token) sessions.delete(token);
}

export const sessionCount = () => sessions.size;

// --- cookies ----------------------------------------------------------------------------------
export const COOKIE = 'pwd_sid';

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

/** Stable pseudonymous id for the ledger, so a username change cannot rewrite history. */
export const actorId = username => createHash('sha256').update(`actor:${username}`).digest('hex').slice(0, 16);
