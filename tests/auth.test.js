import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyCredentials, createSession, getSession, destroySession,
  parseCookies, sessionCookie, clearCookie, actorId, DEMO_ACCOUNTS, demoPassword,
} from '../src/auth.js';

const PW = demoPassword();

test('correct credentials return the account, wrong ones return null', () => {
  const u = verifyCredentials('ee.mehta', PW);
  assert.equal(u.role, 'EE');
  assert.equal(u.name, 'A. Mehta');

  assert.equal(verifyCredentials('ee.mehta', 'wrong'), null);
  assert.equal(verifyCredentials('ee.mehta', ''), null);
  assert.equal(verifyCredentials('nobody', PW), null);
  assert.equal(verifyCredentials('', ''), null);
  assert.equal(verifyCredentials(undefined, undefined), null);
});

test('every demo role has exactly one account', () => {
  assert.deepEqual(DEMO_ACCOUNTS.map(a => a.role).sort(), ['AE', 'EE', 'FIN', 'JE']);
  assert.equal(new Set(DEMO_ACCOUNTS.map(a => a.username)).size, 4);
});

test('no account object ever carries a password or a hash', () => {
  for (const a of DEMO_ACCOUNTS) {
    assert.deepEqual(Object.keys(a).sort(), ['designation', 'name', 'role', 'username']);
  }
  const u = verifyCredentials('je.patel', PW);
  assert.equal(u.hash, undefined);
  assert.equal(u.salt, undefined);
});

test('usernames are case-insensitive and trimmed, passwords are not', () => {
  assert.ok(verifyCredentials('  EE.Mehta  ', PW));
  assert.equal(verifyCredentials('ee.mehta', PW.toUpperCase()), null);
});

test('a session resolves to its account and is destroyed on sign-out', () => {
  const token = createSession('ae.shah');
  assert.equal(getSession(token).role, 'AE');
  destroySession(token);
  assert.equal(getSession(token), null);
});

test('made-up, empty and missing tokens resolve to nothing', () => {
  assert.equal(getSession('notarealtoken'), null);
  assert.equal(getSession(''), null);
  assert.equal(getSession(undefined), null);
  assert.equal(getSession(null), null);
});

test('session tokens are unguessable and unique', () => {
  const tokens = new Set(Array.from({ length: 200 }, () => createSession('je.patel')));
  assert.equal(tokens.size, 200, 'no collisions');
  for (const t of tokens) assert.ok(t.length >= 40, 'at least 256 bits of entropy, base64url');
});

test('the session cookie is HttpOnly, SameSite=Strict and path-scoped', () => {
  const c = sessionCookie('abc');
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\//);
  assert.match(clearCookie(), /Max-Age=0/);
});

test('cookie parsing handles whitespace, encoding and junk', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies('  a = 1 '), { a: '1' });
  assert.deepEqual(parseCookies('a=%2Fx'), { a: '/x' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies('novalue'), {});
  assert.deepEqual(parseCookies(undefined), {});
});

test('actorId is stable, opaque, and does not leak the username', () => {
  const id = actorId('ee.mehta');
  assert.equal(id, actorId('ee.mehta'));
  assert.notEqual(id, actorId('je.patel'));
  assert.doesNotMatch(id, /mehta/);
  assert.match(id, /^[0-9a-f]{16}$/);
});
