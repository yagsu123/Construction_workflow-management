# How to test this project

Three layers, in the order you should reach for them.

| | Command | Needs a running server? | What it proves |
|---|---|---|---|
| **Unit** | `npm test` | no | The rules are right — the hash chain, the stage machine, the validators |
| **Stress** | `npm run stress` | **yes** | The rules hold up under attack, over real HTTP |
| **Integrity** | `npm run verify` | no | The ledger in the database has not been touched |

---

## 1. Unit tests — `npm test`

Pure logic, in-memory database, no network. Fast enough to run after every edit.

```bash
npm test
```

Four files under `tests/`:

- `ledger.test.js` — hashing is deterministic, entries chain to genesis, approvals and
  measurements share one sequence, and tampering is detected
- `workflow.test.js` — the four roles, the stage order, the happy path, and the AE gate
- `measurement.test.js` — photo storage, coordinate validation, role restriction
- `anchor.test.js` — the published-tip check

### Reading a failure

Node's test runner prints TAP. The two lines that matter are the `not ok` and the diff:

```
not ok 3 - the AE test-check sits between the JE and Finance
  expected: [ 'DRAFT', 'PENDING_AE', ... ]
  actual:   [ 'DRAFT', 'PENDING_FINANCE', ... ]
```

To run one file while you work on it:

```bash
node --experimental-sqlite --test tests/workflow.test.js
```

### Writing a new one

Copy the shape of an existing test. The pattern is always: build a fresh in-memory database,
do the thing, assert on what came back.

```js
test('short sentence saying what must be true', () => {
  const db = freshDb();
  act(db, { projectId: 1, role: 'JE', action: 'submit' });
  assert.throws(() => act(db, { projectId: 1, role: 'FIN', action: 'verify' }), /with AE/);
});
```

**Name the test after the guarantee, not the function.** `'Finance cannot reach a file still
awaiting the AE test-check'` tells you what broke when it goes red. `'test act()'` does not.

---

## 2. Stress test — `npm run stress`

This one is adversarial. It runs against a live server and actively tries to break it.

```bash
npm start            # terminal 1
npm run stress       # terminal 2
```

Twelve sections, 41 checks:

1. **Gate enforcement** — every role × every action × every stage (95 illegal combinations)
2. **The AE gate** — Finance and the EE both trying to skip the test-check
3. **Replay** — submitting twice, triggering payment twice
4. **Concurrency** — 12 simultaneous submits, 15 simultaneous photo uploads
5. **Chain integrity** after the concurrency storm
6. **Injection** — `'); DROP TABLE projects;--` and `<img src=x onerror=alert(1)>`
7. **Input validation** — negative budgets, `NaN`, `Infinity`, non-JSON bodies, unknown roles
8. **e-MB validation** — bad coordinates, non-image uploads, SVG, malformed base64
9. **Oversized payloads** — a 6 MB photo, then checking the server is still alive
10. **Path traversal** — `/../../etc/passwd` and five encodings of it
11. **Final integrity** — chain plus every stored photo re-hashed
12. **Anchoring** — published tips agree with the live chain

It exits non-zero if anything fails, so it works in CI.

### Why concurrency is in there

Most workflow bugs are race conditions. Two approvals arriving at the same millisecond is
exactly how a file gets two sequence numbers, or gets approved twice. The test fires twelve
identical submits at once and asserts that **exactly one** succeeds and **exactly one** ledger
entry exists.

---

## 3. Integrity check — `npm run verify`

Recomputes every hash in the database from genesis and prints a per-entry report.

```bash
npm run verify
```

```
  1  ok  APPROVAL    project 1   SUBMITTED by JE
       prev 0000000000…000000  ->  hash 6cd1d04b20…b97c83

  CHAIN VALID — every hash recomputes. Tip cab8f9cfd3…09508c
  ANCHORS MATCH — 30 published tips agree with the chain.
```

Exits 1 when broken, so you can run it on a schedule and get paged.

### Trying to break it on purpose

This is the demo, and it is worth doing by hand once so you understand it.

```bash
sqlite3 ~/.pwd-infra-workflow/app.db \
  "UPDATE approvals SET comment = 'budget verified: Rs 10,00,000' WHERE seq = 2;"
npm run verify
```

```
  2  FAIL  APPROVAL    project 1   VERIFIED by FIN
       ALTERED_PAYLOAD  stored 3cd07f76aa…2ae0d1 but this row now hashes to 9f2b41ce07…4d81aa

  CHAIN BROKEN — first break at seq 2, 1 entry affected.
```

**Two failure modes, and the difference matters:**

- `ALTERED_PAYLOAD` — *this row* was edited. Its contents no longer produce its stored hash.
- `BROKEN_LINK` — this row's `prev_hash` does not match the previous row. Something was
  inserted, deleted, or reordered.

### The attack the chain alone cannot see

A hash chain proves *internal consistency*, not history. Anyone who can write to the database
can edit a row and then recompute every hash after it — the chain is perfect again.

That is why the tip is **anchored**: appended to `~/.pwd-infra-workflow/anchors.log`, outside
the database. Re-signing the chain changes the tip, and the tip no longer matches what was
published at that length.

```bash
npm run verify
```

```
  ANCHOR MISMATCH — the chain is internally consistent but does not match what was
  published. Somebody rewrote history and re-signed it.

    at length 2, anchored 5687e1ff3f…a91c02 but the chain now gives 826524b03e…77f4e1
```

In production the anchor goes to a public blockchain instead of a local file. Same idea,
different scale — and it is the honest answer to "why not just recompute the hashes?"

---

## 4. Testing the browser bits by hand

The parts no script covers, because they need a real browser:

**Geolocation.** Open a project as the JE, click *Get location fix*. Deny permission once —
you should get a readable refusal, not a silent failure. Browsers only give coordinates on
`localhost` or HTTPS; on a phone over the LAN it will be blocked, which is expected.

**Role switching.** Change the dropdown on a project sitting at `PENDING_AE`. Only the AE
should see buttons. Everyone else should see *"this project is with AE"*.

**Escaping.** Create a project titled `<img src=x onerror=alert(1)>`. It must appear as
literal text. If a dialog pops up, an `esc()` call is missing.

**Dark mode.** Switch your OS theme. Every screen is built on tokens that flip automatically.

---

## Before you demo

```bash
npm test && npm start & sleep 2 && npm run stress && npm run verify
```

All three green means the rules are right, they survive abuse, and the ledger is untouched.
