# Phase 0 — Scope & Stack Lock-In

Locked on 2026-09-20. **Not revisited later.**

## Stack

| Layer | Decision | Why |
|---|---|---|
| Runtime | Node.js 22 (`node:http`) | Already installed; zero build step |
| Database | **SQLite via Node's built-in `node:sqlite`** | Real SQL, real `.db` file, **zero npm install** |
| Frontend | Server-rendered HTML + vanilla JS, no framework | No bundler, no `node_modules`, instant reload |
| Ledger | Hand-rolled SHA-256 hash chain (`node:crypto`) | Simulates smart-contract immutability |
| Dependencies | **None.** `npm install` is not required to run this project. | |

### Deviation from the original plan

The plan specified **Next.js + React**. During Phase 0, `npm install` stalled repeatedly on this
machine — the repo lives inside a OneDrive-synced folder, and writing ~300 packages (plus the
native `better-sqlite3` build) through that mount did not complete inside a 2-minute window.

Rather than risk a demo that depends on a fragile install, the stack was changed to **zero
dependencies**. Everything the plan calls for is still delivered:

- Real SQLite database file — tamper demo still works by editing rows directly
- Same three tables, same `appendLedgerEntry()` hash chain
- Same screens: submission, stepper, role switcher, e-MB upload, ledger viewer, delay dashboard

What is lost: React component ergonomics. For a ~6-screen demo app this is not a meaningful cost,
and `git clone && npm start` now works on any machine with Node 22, with no network access.

## Roles (hardcoded, no real auth)

Ledger entries now record *who* acted, not only which role: `actor_user` carries a stable
pseudonymous id derived from the account, so a rename cannot rewrite history.

1. **JE** — Junior Engineer: creates DPRs, records geo-tagged e-MB entries from site
2. **AE** — Assistant Engineer / Sub-Divisional Officer: **test-checks** the JE's physical
   measurements, re-verifying a prescribed percentage before the file may move for payment
3. **FIN** — Finance / Accounts: verifies the claim against the sanctioned budget head
4. **EE** — Executive Engineer: final approval, triggers the simulated smart contract

**Revision 3 replaced the role dropdown with real sign-in.** The dropdown meant the client
declared its own role and the server believed it — anyone with `curl` could approve their own
bill as the Executive Engineer. For a system whose entire claim is accountability, that was not
a shortcut, it was a contradiction. Roles now come from a password-protected session, and the
`role` field in a request body is never read.

Each role has one departmental account (`je.patel`, `ae.shah`, `fin.desai`, `ee.mehta`).
Passwords are scrypt-hashed with a per-account salt and compared in constant time. Sessions are
opaque 256-bit tokens in an `HttpOnly; SameSite=Strict` cookie, held in memory for 8 hours.

Still demo-scale, and honestly so: fixed accounts, no password reset, no rate limiting, sessions
lost on restart, one shared demo password shown on the login page. But there is no path from the
browser to a role that does not go through a password.

**Revision 2 added the AE.** The first cut routed the JE's measurements straight to Finance,
which is not how an Indian PWD file actually moves — the AE test-check is mandatory, and
omitting it would misrepresent both the process and where files really get stuck. It is also
the gate most often blamed for delay and most often bypassed in corruption cases, which makes
it the single most worthwhile gate to instrument.

## Ledger approach

A single append-only chain shared by **both** approvals and measurements, so there is one
unified audit trail:

```
hash = SHA256( canonical_json(payload) + prev_hash )
```

`prev_hash` of the first entry is the genesis constant `"0".repeat(64)`.
Chain validity is re-checked by recomputing every hash in sequence.

**Not** a real Solidity contract on Polygon. The architecture diagram shows where a real chain
would sit; this build simulates its guarantees so the workflow can be demonstrated end to end.

## Explicit non-goals

Not attempted, and not to be attempted later:

- Real blockchain SDK / wallet / gas / testnet deployment
- PFMS or State Treasury integration (payment trigger is a logged simulated event)
- Real GIS / map tile APIs (coordinates shown as text + an OpenStreetMap link)
- Multi-department parallel clearances (the workflow is strictly linear: JE → AE → FIN → EE)
- File storage beyond the local `public/uploads/` folder
- Password reset, account management, rate limiting, or persistent sessions
- Multi-user roles (one account per role, not per person)

## Stage machine

```
DRAFT -> PENDING_AE -> PENDING_FINANCE -> PENDING_EE -> APPROVED -> PAYMENT_TRIGGERED
```

Rejection at AE, FIN or EE returns the project to `DRAFT` and is recorded on the ledger as a
`REJECTED` entry — rejections are never silently dropped.

Exactly one role holds each stage, enforced by a test: a file can never be actionable by two
people at once, and the AE gate cannot be bypassed by acting as Finance early.
