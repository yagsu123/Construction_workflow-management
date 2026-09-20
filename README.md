# Construction Workflow Management

**Infrastructure Workflow & Construction Monitoring System** — a digital Measurement Book (MB)
approval workflow for a Public Works Department, with a tamper-evident hash-chained ledger
standing in for a smart contract, and a public-facing delay dashboard that flags stalled files.

The problem it targets: MB approvals move between Junior Engineer, Finance and Executive
Engineer on paper, where files can sit for months with no accountability and measurements can be
altered after the fact. This system makes every approval and every site measurement an
append-only, hash-linked record — and makes the *waiting* visible.

## Run it

```bash
git clone https://github.com/yagsu123/Construction_workflow-management.git
cd Construction_workflow-management
npm start
```

Then open <http://localhost:3000>.

**There is no `npm install` step.** The project has zero dependencies — it needs only
**Node.js 22.5 or newer**, which ships SQLite in its standard library.

| Command | What it does |
|---|---|
| `npm start` | Run the app on port 3000 (`PORT=4000 npm start` to change) |
| `npm run seed` | Load the demo dataset *(Phase 5)* |
| `npm run verify` | Re-validate the whole ledger chain *(Phase 1)* |
| `npm run tamper` | Edit a row behind the ledger's back, to break the chain on purpose *(Phase 6)* |
| `npm test` | Ledger unit tests *(Phase 1)* |

## How it works

Three hardcoded roles, switched from a dropdown — no login:

```
JE (uploads geo-tagged MB images)
  -> Finance / Accounts (budget verification)
     -> Executive Engineer (final approval)
        -> Smart contract (payment trigger)
```

A rejection at Finance or EE sends the project back to the JE, and the rejection itself is
written to the ledger — it cannot be quietly dropped.

Every approval and every measurement appends one entry to a single shared chain:

```
hash = SHA256( canonical_json(payload) + prev_hash )
```

Change any historical row directly in the database and every subsequent hash stops matching,
which the verifier reports with the exact index where the chain breaks. That is the
"why blockchain" argument, demonstrable in about sixty seconds.

## Stack

Node.js 22 · `node:http` · `node:sqlite` · `node:crypto` · server-rendered HTML and vanilla JS.
No framework, no bundler, no `node_modules`.

The original plan called for Next.js/React with `better-sqlite3`; that was swapped for a
zero-dependency build during Phase 0. The reasoning, the role definitions, the stage machine and
the explicit non-goals are recorded in [`DECISIONS.md`](./DECISIONS.md).

## Status

Phases 0–2 of 6 complete.

- **Phase 0** — stack locked, scaffold up, health check green
- **Phase 1** — schema, `appendLedgerEntry()`, `verifyChain()`, 11 passing tests
- **Phase 2** — DPR submission, stage stepper, role switcher, approve/reject with
  rejections looping back to the JE and recorded on the ledger
- **Phase 3** — geo-tagged e-MB capture: photo + GPS fix + note, with the photo's own
  SHA-256 inside the ledger payload, so swapping the image file is detectable too

Next: the ledger viewer and delay dashboard (Phase 4), seed data (Phase 5), demo rehearsal (Phase 6).

## Not in scope

No real blockchain deployment, no PFMS or Treasury integration, no map tile APIs, no real
authentication. The payment trigger is a logged simulated event. See `DECISIONS.md`.
