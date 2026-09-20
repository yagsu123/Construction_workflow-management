# Running the demo

## Starting it — read this first

```powershell
cd C:\Users\tcpladmin255\OneDrive\Desktop\construction_project_hackathon
npm run seed
npm start
```

You should see:

```
  PWD Infrastructure Workflow
  http://localhost:3000
```

Leave that running and open the site. `npm test`, `npm run stress` and `npm run verify` can all
be run from a second window — or from the same one after you stop the server with Ctrl+C, since
the stress test starts its own if none is running.

**Sign in.** The login page lists four accounts; the password for all of them is `demo1234`.

| Account | Role |
|---|---|
| `je.patel` | Junior Engineer |
| `ae.shah` | Assistant Engineer / SDO |
| `dee.desai` | Deputy Executive Engineer |
| `ee.mehta` | Executive Engineer |

If the browser shows an old version, **hard-refresh with Ctrl+Shift+R** — the browser caches
`common.js` and will happily keep showing you a stale page.

---

## What you should see

`npm run seed` loads five projects, deliberately spread across the workflow:

| Code | Sitting at | Days | Why it's there |
|---|---|---|---|
| PWD/2026/001 | AE test-check | **23** | Past SLA — the headline |
| PWD/2026/002 | DEE | 9 | Was rejected by the AE, then fixed and resubmitted |
| PWD/2026/003 | DEE | **11** | Past SLA |
| PWD/2026/004 | EE approval | 2 | **Click this one through live** |
| PWD/2026/005 | Done | 1 | Full chain, start to finish |

---

## The four-minute walkthrough

### 1. The problem (30 sec) — **Delay dashboard**

Open **Delay dashboard**. Three of four live files are past the 7-day SLA.

Then point at *Where files are waiting*:

```
AE    1 file    1 past SLA    avg 23 d    worst 23 d
DEE   2 files   2 past SLA    avg 10 d    worst 11 d
EE    1 file    0 past SLA    avg  2 d    worst  2 d
```

**Say this:** *"This doesn't say the department is slow. It says exactly which desk the file is
dying on — and right now that's the AE test-check, at 23 days."*

That's the whole anti-corruption argument. Delay becomes attributable.

### 2. The workflow (90 sec) — **PWD/2026/004**

Open it. The stepper shows it at **EE Final Approval**, with JE, AE and the DEE behind it.

Now demonstrate that roles are enforced, not decorative:

1. Signed in as `je.patel` → no buttons. *"It's not with him."*
2. Sign out, sign in as `dee.desai` → no buttons.
3. Sign in as `ee.mehta` → **Grant final approval** appears. Click it.
4. **Execute smart contract** appears. Click it.

Scroll to the timeline: two new entries, each with `prev_hash → hash`.

**Say this:** *"Four roles, one file, and nobody can act out of turn. And this isn't a dropdown —
each role is a separate login. The server works out who you are from your session; if you send it
a request claiming to be the Executive Engineer, it ignores you."*

If a judge is technical, show them:

```powershell
curl -i -X POST http://localhost:3000/api/projects/4/action -H "content-type: application/json" -d "{\"role\":\"EE\",\"action\":\"approve\"}"
```

`401 Not signed in`.

### 3. Rejection is recorded (45 sec) — **PWD/2026/002**

Open it and scroll the timeline. Partway down:

> **REJECTED** by **AE** — *"Re-measured chainage 180–240 m: invert 40 mm above drawing.
> Returned for correction."*

**Say this:** *"On paper, a file sent back with a verbal objection leaves no trace. That's where
accountability dies. Here the rejection is a permanent, hash-linked record — and you can see
the JE's corrected re-measurement right after it."*

### 4. The site photo (30 sec) — **PWD/2026/001**

Sign in as `je.patel`. Each e-MB entry shows the photo, the coordinates as a link to the real
map location, and the photo's own hash.

**Say this:** *"The measurement isn't a number somebody typed. It's a photo, at a location, at a
time, and all three are inside the hash."*

*(Optional, live: click **Get location fix**, attach any photo, **Record on ledger**. Only works
on `localhost` or HTTPS — browsers block geolocation otherwise.)*

### 5. The payoff (60 sec) — **Ledger → tamper**

Open **Ledger**. Green banner: *Chain valid — all 23 entries recompute, and 23 published tips
agree.* Every row shows `prev_hash → hash`.

Now, in your second window:

```powershell
npm run tamper edit
```

It prints before, the edit it made, and after:

```
  before
    chain   valid     23 entries, tip 46d7b19bbf…78275f
  Editing approval seq 17 directly in SQLite
    was: Budget head BE-2026-41 confirmed, within sanctioned estimate
    now: Budget head BE-2026-41 confirmed — revised to Rs 2,45,00,000
  after
    chain   BROKEN at seq 17
  Caught. Entry 17 no longer hashes to its stored value.
```

Refresh the Ledger page — red banner, and row 17 tinted with `ALTERED_PAYLOAD`.

**Say this:** *"One row changed in the database. Nobody touched the application, nobody logged
in. The ledger caught it and named the exact record."*

### 6. The question you will be asked (45 sec)

Someone sharp will say: *"If I can edit the database, can't I just recompute all the hashes?"*

**Yes.** Say so — then show them you handled it.

```powershell
npm run tamper restore
npm run tamper resign
```

```
  after
    chain   valid     23 entries, tip 4ad4bd4178…71e821
    anchors MISMATCH  23 published

  The chain says VALID — and it is right. Every hash recomputes.
  Caught by the anchors.
    at length 17:  published bcade623f8…771a70
                    chain now 3a47f5cf63…59e583
```

**Say this:** *"A hash chain proves internal consistency, not history. So after every entry we
publish the tip somewhere the database can't reach. Rewriting history changes the tip, and the
tip no longer matches what was published. In production that's a public blockchain — here it's
an append-only file. Same argument."*

That answer is worth more than the demo itself: it shows you know where your own design ends.

### 7. Optional third beat — the swapped photo (30 sec)

Only if you have time, or if someone asks about the photos.

```powershell
npm run tamper restore
npm run tamper photo
```

```
  chain still valid — correct, because the record was not altered.
  photo       MISMATCH
```

Refresh the Ledger — that e-MB row carries a **photo swapped** flag.

**Say this:** *"The record is untouched, so the chain is right to say it's valid. But the photo
it points at isn't the photo that was signed — the image's own hash is inside the entry."*

### Resetting between runs

```powershell
npm run tamper restore
```

Reseeds everything, anchors included. Run it after every attack.

---

## The 60-second rehearsal

Practise these six moves until you don't need the notes. Two windows: browser, and PowerShell.

| | Do | Say | ~ |
|---|---|---|---|
| 1 | Ledger page, point at the green banner | "Every approval and every site measurement, one chain, all verified." | 8 s |
| 2 | `npm run tamper edit` | "I'm editing the database directly — no login, no API." | 10 s |
| 3 | Point at `BROKEN at seq 17` | "Caught, and it names the record." | 7 s |
| 4 | Refresh the Ledger, point at the red row | "And the page says so to anyone who looks." | 8 s |
| 5 | *"Can't you just recompute the hashes?"* — `npm run tamper resign` | "Yes, you can. So we publish the tip outside the database." | 15 s |
| 6 | Point at `anchors MISMATCH` | "Chain says valid. The published tip says otherwise." | 10 s |

**Rehearsal notes**

- Run `npm run tamper restore` **before you go on stage**, and again between practice runs.
  A stale broken chain makes step 1 start red.
- Have the Ledger page already open and scrolled to the top.
- `npm run tamper edit` prints before *and* after itself, so you never need to run `verify`
  separately during the demo.
- Do not skip step 5 even if nobody asks. Ask it yourself: *"Now, the obvious objection is…"*.
  Pre-empting your own weakness reads as confidence; being caught by it does not.

---

## If something looks wrong

| Symptom | Cause |
|---|---|
| `ECONNREFUSED` / "fetch failed" | The server isn't running. `npm start` in window 1. |
| Page looks like an older version | Browser cache. **Ctrl+Shift+R**. |
| "No projects found" | Empty database. `npm run seed`. |
| Location fix fails | Geolocation needs `localhost` or HTTPS, and browser permission. |
| Sent to the login page | Session expired (8 h) or the server restarted — sessions are in memory. |
| Days-in-stage all read 0 | You re-seeded; the dates are relative to seed time. That's expected. |
