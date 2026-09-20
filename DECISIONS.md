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

1. **JE** — Junior Engineer: creates DPRs, uploads geo-tagged e-MB entries
2. **FIN** — Finance / Accounts: verifies budget
3. **EE** — Executive Engineer: final approval, triggers the simulated smart contract

Switched via a dropdown in the header. No login, no passwords, no sessions.

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
- Multi-department parallel clearances (the workflow is strictly linear: JE → FIN → EE)
- File storage beyond the local `public/uploads/` folder
- Real authentication, RBAC, or audit of *who* switched roles

## Stage machine

```
DRAFT -> PENDING_FINANCE -> PENDING_EE -> APPROVED -> PAYMENT_TRIGGERED
```

Rejection at FIN or EE returns the project to `DRAFT` and is recorded on the ledger as a
`REJECTED` entry — rejections are never silently dropped.
