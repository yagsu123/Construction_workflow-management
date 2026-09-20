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
npm run seed     # load the demo dataset
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
| `npm run tamper` | Three attacks on the ledger — `edit`, `resign`, `photo`, plus `restore` |
| `npm test` | Ledger unit tests *(Phase 1)* |

## How it works

Four departmental accounts, one per role. **You sign in with a password** — the role is not
something the browser can choose:

```
JE  (records geo-tagged MB entries from site)
  -> AE / SDO (test-check: re-measures a prescribed percentage)
     -> Finance / Accounts (budget verification)
        -> Executive Engineer (final approval)
           -> Smart contract (payment trigger)
```

The **AE test-check is mandatory in Indian PWD practice** and cannot be bypassed here — Finance
acting on a file still awaiting test-check is refused outright.

A rejection at the AE, Finance or the EE sends the project back to the JE, and the rejection
itself is written to the ledger — it cannot be quietly dropped.

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
- **Phase 2** — DPR submission, stage stepper, four-role switcher, approve/reject with
  rejections looping back to the JE and recorded on the ledger
- **Phase 3** — geo-tagged e-MB capture: photo + GPS fix + note, with the photo's own
  SHA-256 inside the ledger payload, so swapping the image file is detectable too
- **Phase 4** — ledger viewer with a live integrity verdict, and a delay dashboard that
  attributes waiting time to the role holding each file

- **Phase 5** — demo dataset: five projects spread across the workflow, one rotting at the
  AE test-check, one showing a full AE rejection and recovery
- **Authentication** — the role dropdown was replaced with scrypt-hashed sign-in and
  `HttpOnly` session cookies; the server derives the role from the session and ignores any
  `role` sent by the client
- **Phase 6** — the tamper demo as three scripted attacks, each printing the chain state
  before and after, with a timed six-move rehearsal in [`DEMO.md`](./DEMO.md)

Testing: `npm test` (45 unit), `npm run stress` (54 adversarial checks — it starts its own
server if none is running), `npm run verify` (ledger integrity). See [`TESTING.md`](./TESTING.md).

Demo logins are listed on the sign-in page. Password for all of them: `demo1234`.
Running the demo, screen by screen: [`DEMO.md`](./DEMO.md).

**All six phases complete.**

The full phase plan, including the Indian-context revision that introduced the AE gate, is in
[`docs/build-plan.md`](./docs/build-plan.md).

## Not in scope

No real blockchain deployment, no PFMS or Treasury integration, no map tile APIs. Sign-in is
real but demo-scale: fixed accounts, one shared password, in-memory sessions. The payment
trigger is a logged simulated event. See `DECISIONS.md`.
