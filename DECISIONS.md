# Decisions

Why this is built the way it is. Each entry records what was chosen, what it cost, and what was
deliberately not attempted.

## Stack

| Layer | Decision | Why |
|---|---|---|
| Runtime | Node.js 22 (`node:http`) | Already installed; zero build step |
| Database | SQLite via Node's built-in `node:sqlite` | Real SQL, real `.db` file, **zero npm install** |
| Frontend | Server-rendered HTML + vanilla JS | No bundler, no `node_modules`, instant reload |
| Ledger | Hand-rolled SHA-256 hash chain (`node:crypto`) | Simulates smart-contract immutability |
| Dependencies | **None** | `git clone && npm start` works with no network |

### Why not Next.js

The original plan specified Next.js + React. During Phase 0, `npm install` stalled repeatedly:
the repo lives inside a OneDrive-synced folder, and writing ~300 packages plus the native
`better-sqlite3` build through that mount did not complete inside a two-minute window.

Rather than risk a demo depending on a fragile install, the stack was changed to zero
dependencies. Everything the plan called for is still delivered — the real SQLite file the tamper
demo edits directly, the same `appendLedgerEntry()` chain, the same screens. What is lost is
React component ergonomics, which for a seven-screen app is not a meaningful cost.

### Why the database lives outside the repo

`~/.pwd-infra-workflow/app.db`, not `./data/`. A live SQLite file in a synced folder is a real
hazard: the sync client holds handles on the memory-mapped `-wal`/`-shm` side files, which
produced `SQLITE_IOERR` on open and left undeletable files behind. Worse, a sync client copying a
database mid-write can corrupt it outright. The demo data is reproducible with `npm run seed`
anyway. Override with `DB_PATH`.

---

## Roles

| Role | Duty |
|---|---|
| **CONTRACTOR** | Submits RA bills |
| **JE** — Junior Engineer | Prepares tender packages; records geo-tagged e-MB entries from site |
| **AE** — Assistant Engineer / SDO | Test-checks a prescribed percentage of the JE's measurements |
| **DEE** — Deputy Executive Engineer | Physical test-check of ~30% of the work; accords sub-divisional technical approval |
| **EE** — Executive Engineer | Technical Sanction, authorises ITT publication, final bill approval, triggers the smart contract |

Ledger entries record *who* acted, not only which role: `actor_user` carries a stable
pseudonymous id derived from the account, so a rename cannot rewrite history.

### Revision 1 — the AE gate was added

The first cut routed the JE's measurements straight to the accounts branch, which is not how an
Indian PWD file actually moves. The AE test-check is mandatory, and omitting it would
misrepresent both the process and where files really get stuck. It is also the gate most often
blamed for delay and most often bypassed in corruption cases, which makes it the single most
worthwhile gate to instrument.

### Revision 2 — the role dropdown was replaced with real sign-in

The dropdown meant the client declared its own role and the server believed it: anyone with
`curl` could approve their own bill as the Executive Engineer. For a system whose entire claim is
accountability, that was not a shortcut, it was a contradiction.

Roles now come from a password-protected session and the `role` field in a request body is never
read. Passwords are scrypt-hashed with a per-account salt and compared in constant time; sessions
are opaque 256-bit tokens in an `HttpOnly; SameSite=Strict` cookie, held in memory for 8 hours.

Still demo-scale, and honestly so: fixed accounts, no password reset, no rate limiting, sessions
lost on restart, one shared password shown on the login page. But there is no path from the
browser to a role that does not go through a password.

### Revision 3 — the Divisional Accountant became the DEE

The stage between the AE and the EE was originally Finance / Accounts, verifying the claim
against the sanctioned budget head and computing statutory deductions. It is now the **Deputy
Executive Engineer**, who conducts the physical test-check of around 30% of the work and accords
sub-divisional technical approval.

The gain is two independent physical verifications of the same measurements by two different
officers, rather than one measurement check followed by an arithmetic check. The cost is explicit
and recorded under non-goals: GST, TDS and cess computation left the workflow with the role.

---

## The ledger

One append-only chain shared by tender events, approvals, measurements, delay logs and EOT
decisions, ordered by a single monotonic sequence, so there is one unified audit trail:

```
hash = SHA256( canonical_json(payload) + prev_hash )
```

`prev_hash` of the first entry is the genesis constant `"0".repeat(64)`. Validity is re-checked
by recomputing every hash in sequence.

**Not** a real Solidity contract on Polygon. This build simulates the guarantees so the workflow
can be demonstrated end to end; the architecture diagram shows where a real chain would sit.

### The chain tip is anchored outside the database

Recomputing hashes catches an edited row, but not an attacker who edits a row *and* re-signs
every hash after it — that chain is internally consistent. So each new tip is also appended to
`anchors.log`, outside the database. A re-signed chain no longer matches the published tips, and
there is nothing inside the database that can reach them.

### State and history are separate tables — a lesson learned late

`src/tender.js` writes to two tables: `tenders` holds current state and is updated; `tender_events`
is append-only and carries the chain. Nothing in the events table is ever modified.

`delay_logs` and `eot_requests` do not make this split — each row is both the ledger entry and the
mutable state — and it does not work. Appending a second EOT entry reuses the request's `id`,
which is the primary key, and the insert fails on the unique constraint. The EOT review chain
therefore throws, and the fix is to restructure it the way the tender module is built.

### Ledger payloads must match what `readChain()` projects

A hash commits to a payload. If `readChain()` does not project a column that payload includes,
verification recomputes a different hash and reports `ALTERED_PAYLOAD` on data nobody touched.
This was live for delay and EOT entries: a freshly seeded database reported a broken chain. Any
new entry type must add its columns to every branch of the `readChain()` union.

---

## Stage machines

Tender initiation:

```
PACKAGE_DRAFT -> PENDING_DEE -> PENDING_TS -> PENDING_PUBLISH -> PUBLISHED -> AWARDED
                                     |
                                     +-> PARKED (no budget)
```

Execution:

```
DRAFT -> PENDING_JE -> PENDING_AE -> PENDING_DEE -> PENDING_EE -> APPROVED -> PAYMENT_TRIGGERED
```

Exactly one role holds each stage, enforced by tests: a file can never be actionable by two
people at once, and the AE gate cannot be bypassed by acting as the DEE early. Rejections and
returns move the file back and are recorded on the ledger — never silently dropped.

Two acts require a DSC PIN, both by the EE: authorising publication of an ITT, and final approval
of a bill. Both are the moment a signature would actually be applied in practice.

---

## Explicit non-goals

Not attempted, and not to be attempted later:

- Real blockchain SDK, wallet, gas or testnet deployment
- Bid submission, evaluation or comparative statement — tender initiation stops at publication
  and resumes at the work order
- Financial verification of bills: GST, TDS and cess left with the Divisional Accountant role
- PFMS or State Treasury integration — the payment trigger is a logged simulated event
- Real GIS or map tile APIs (coordinates shown as text plus an OpenStreetMap link)
- Multi-department parallel clearances — both workflows are strictly linear
- File storage beyond the local `public/uploads/` folder
- Password reset, account management, rate limiting, persistent sessions
- Multi-user roles — one account per role, not per person
