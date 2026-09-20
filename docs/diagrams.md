# Infraledger — Workflow Diagrams

Six views of the system, drawn from the code rather than the pitch: the stage machine in
`src/config.js` + `src/workflow.js`, the validation pipeline in `recordMeasurement()`, the
delay/EOT lifecycle in `src/workflow.js` + `src/delays.js`, and the chain in `src/ledger.js`.

All diagrams are Mermaid and render directly on GitHub.

---

## 1. The approval stage machine

The linear path, the three rejection edges, and the one gate that cannot be skipped.

```mermaid
stateDiagram-v2
    direction TB

    [*] --> DRAFT

    DRAFT: DRAFT — RA Bill Prep
    PENDING_JE: PENDING_JE — e-MB Recording
    PENDING_AE: PENDING_AE — AE Test-Check
    PENDING_FINANCE: PENDING_FINANCE — FA Verification
    PENDING_EE: PENDING_EE — EE Final Approval
    APPROVED: APPROVED
    PAYMENT_TRIGGERED: PAYMENT_TRIGGERED

    DRAFT --> PENDING_JE: CONTRACTOR · submit_ra<br/>RA_SUBMITTED
    PENDING_JE --> PENDING_AE: JE · submit<br/>SUBMITTED
    PENDING_AE --> PENDING_FINANCE: AE · test_check<br/>TEST_CHECKED
    PENDING_FINANCE --> PENDING_EE: FA · verify<br/>VERIFIED
    PENDING_EE --> APPROVED: EE · approve (DSC PIN)<br/>APPROVED
    APPROVED --> PAYMENT_TRIGGERED: EE · trigger_payment<br/>PAYMENT_TRIGGERED

    PENDING_AE --> PENDING_JE: reject — measurement mismatch
    PENDING_FINANCE --> PENDING_JE: reject — discrepancy flagged
    PENDING_EE --> PENDING_JE: reject

    PAYMENT_TRIGGERED --> [*]

    note right of PENDING_AE
        Mandatory gate. FA acting on a file
        still awaiting test-check is refused
        outright — the transition does not exist.
    end note

    note left of PENDING_JE
        Every rejection is appended to the
        ledger before the stage moves back.
        A rejection cannot be quietly dropped.
    end note
```

**SLA:** a project sitting in any one stage for more than `SLA_DAYS = 7` is flagged red on the
delay dashboard, attributed to the role holding it.

---

## 2. Who may do what, and when

Each lane can only act while the file is on its own desk.

```mermaid
flowchart LR
    subgraph CON["CONTRACTOR — Primary Contractor"]
        C1["Submit RA Bill"]
        C2["Log ground delay"]
        C3["Raise EOT request"]
    end

    subgraph JE["JE — Junior Engineer"]
        J1["Record geo-tagged e-MB entry"]
        J2["Submit for AE test-check"]
        J3["Log ground delay / raise EOT"]
    end

    subgraph AE["AE / SDO — Assistant Engineer"]
        A1["Test-check physical measurements"]
        A2["Reject: measurement mismatch"]
        A3["Recommend EOT days"]
    end

    subgraph FA["FA — Divisional Accountant"]
        F1["Verify budget"]
        F2["Compute GST / TDS / Cess"]
        F3["Reject: flag discrepancy"]
    end

    subgraph EE["EE — Executive Engineer"]
        E1["Final approval — DSC PIN"]
        E2["Reject"]
        E3["Approve / reject EOT days"]
        E4["Execute smart contract"]
    end

    C1 --> J1 --> J2 --> A1 --> F1 --> E1 --> E4
    A2 -.-> J1
    F3 -.-> J1
    E2 -.-> J1
    C3 --> A3 --> E3
    J3 --> A3
```

---

## 3. The e-MB capture pipeline

Three independent checks stand between a photo and a signed measurement. The interesting design
choice is at the EXIF step: **absence is not evidence, but contradiction is.**

```mermaid
flowchart TD
    START(["JE opens e-MB capture"]) --> CAP["Browser captures<br/>photo + GPS fix + note"]
    CAP --> ROLE{"role == JE ?"}
    ROLE -- no --> RJ1["Refused:<br/>only the JE records measurements"]:::bad
    ROLE -- yes --> CLOSED{"stage == PAYMENT_TRIGGERED ?"}
    CLOSED -- yes --> RJ2["Refused:<br/>measurement book is closed"]:::bad
    CLOSED -- no --> VALID{"lat / lng in range<br/>and photo present ?"}
    VALID -- no --> RJ3["Refused:<br/>enable location access"]:::bad

    VALID -- yes --> GEO{"Geofence — haversine<br/>distance ≤ site_radius_m<br/>(default 250 m)"}
    GEO -- "outside" --> RJ4["Refused:<br/>'You are 1.4 km from the registered site'"]:::bad

    GEO -- "inside" --> EXIF{"Photo carries<br/>EXIF GPS ?"}
    EXIF -- "no · policy = strict" --> RJ5["Refused:<br/>camera photo with location required"]:::bad
    EXIF -- "no · policy = warn" --> UNV["Accepted, permanently stamped<br/>photo_verified = UNVERIFIED"]:::warn

    EXIF -- "yes" --> DRIFT{"EXIF GPS within<br/>EXIF_DRIFT_M (200 m)<br/>of the reported fix ?"}
    DRIFT -- no --> RJ6["Refused:<br/>'the photo was not taken where<br/>this entry claims it was'"]:::bad
    DRIFT -- yes --> AGE{"Capture time within<br/>EXIF_MAX_AGE_HOURS (24 h)<br/>and not in the future ?"}
    AGE -- no --> RJ7["Refused:<br/>stale or future-dated photo"]:::bad
    AGE -- yes --> CONF["photo_verified = EXIF_CONFIRMED"]:::ok

    UNV --> HASH
    CONF --> HASH["SHA-256 of the photo file itself"]
    HASH --> SIGN["appendLedgerEntry('MEASUREMENT', …)<br/>photo_sha256 · lat · lng · distance_m ·<br/>exif_lat · exif_lng · photo_verified"]:::ledger
    SIGN --> DONE(["Entry sealed into the shared chain"])

    classDef bad fill:#fde8e8,stroke:#c53030,color:#742a2a;
    classDef warn fill:#fdf6e3,stroke:#b7791f,color:#744210;
    classDef ok fill:#e6f6ec,stroke:#2f855a,color:#22543d;
    classDef ledger fill:#e8f0fe,stroke:#2b6cb0,color:#1a365d;
```

Because the photo's own hash is inside the signed payload, swapping the image file on disk
breaks the chain too — not just editing the database row.

---

## 4. Ground delay and Extension of Time

Deliberately separate from the approval workflow. "Which desk is the file sitting on" is the
corruption signal; "why is the road not getting built" is a different question, and conflating
them is how a system loses the engineers who have to use it.

```mermaid
flowchart TD
    OBS(["Work stalls on site"]) --> LOG["JE or CONTRACTOR logs a delay<br/>category · responsibility · impact_days · evidence"]:::ledger
    LOG --> ST1["delay_log.status = LOGGED"]

    ST1 --> PARTY{"delay_responsibility"}

    PARTY -- EXTERNAL --> EXT["Land acquisition · utility shifting<br/>statutory clearance · court stay<br/>encroachment · law & order · weather"]
    PARTY -- DEPARTMENT --> DEP["Funds awaited · drawing revision<br/>site not handed over · decision awaited"]
    PARTY -- CONTRACTOR --> CTR["Material / labour shortage · equipment<br/>slow progress · rework after quality failure"]:::bad

    EXT --> EOT
    DEP --> EOT
    CTR -- "excusable = false" --> LD["Not EOT-grantable —<br/>days count against the contractor"]:::bad

    EOT["JE or CONTRACTOR raises EOT request<br/>requested_days"] --> UR["delay_log.status = UNDER_REVIEW<br/>eot.status = PENDING_AE"]
    UR --> AER["AE recommends days<br/>recommended_days_by_ae"]:::ledger
    AER --> PE["eot.status = PENDING_EE"]
    PE --> EED{"EE decision"}

    EED -- APPROVED --> APR["approved_days_by_ee recorded<br/>ledger_block_hash stamped on the request"]:::ok
    EED -- REJECTED --> REJ["rejection_reason recorded"]:::bad

    APR --> RES["delay_log.status = RESOLVED"]
    REJ --> RES

    RES --> SUM["delaySummary():<br/>total_days · excusable_days ·<br/>contractor_days · approved_eot_days<br/>split by party and by reason"]

    classDef bad fill:#fde8e8,stroke:#c53030,color:#742a2a;
    classDef ok fill:#e6f6ec,stroke:#2f855a,color:#22543d;
    classDef ledger fill:#e8f0fe,stroke:#2b6cb0,color:#1a365d;
```

Every step marked in blue is itself a ledger entry — the delay log, the AE recommendation and the
EE decision are all appended to the same chain as the approvals.

---

## 5. The ledger: one chain, four record types

Approvals, measurements, delay logs and EOT decisions share a single monotonic `seq` counter, so
they form **one** ordered chain rather than four parallel ones.

```mermaid
flowchart LR
    G["GENESIS<br/>prev_hash = 000…0"]:::gen
    B1["seq 1 · APPROVAL<br/>RA_SUBMITTED"]
    B2["seq 2 · MEASUREMENT<br/>photo_sha256 · lat/lng"]
    B3["seq 3 · APPROVAL<br/>SUBMITTED"]
    B4["seq 4 · DELAY_LOG<br/>LAND_ACQUISITION"]
    B5["seq 5 · APPROVAL<br/>REJECTED — mismatch"]
    B6["seq 6 · EOT_APPROVAL<br/>PENDING_EE"]
    B7["seq n · APPROVAL<br/>PAYMENT_TRIGGERED"]

    G --> B1 --> B2 --> B3 --> B4 --> B5 --> B6 --> B7

    B7 --> ANC["anchors.log<br/>chain tip written OUTSIDE the database"]:::anc

    classDef gen fill:#edf2f7,stroke:#4a5568;
    classDef anc fill:#faf5ff,stroke:#6b46c1,color:#44337a;
```

```
hash = SHA256( canonical_json(payload) + prev_hash )
```

### Why the anchor exists

```mermaid
flowchart TD
    T{"Attack"} --> E["edit — change a historical row<br/>directly in SQLite"]
    T --> R["resign — change a row AND<br/>recompute every hash after it"]
    T --> P["photo — swap the image file on disk,<br/>leave the database untouched"]

    E --> V1["verifyChain() reports the exact index<br/>where prev_hash stops matching"]:::ok
    R --> V2["The chain is internally consistent —<br/>verifyChain() alone would pass"]:::bad
    V2 --> V3["Tip no longer matches anchors.log,<br/>which the database cannot reach"]:::ok
    P --> V4["Recomputed photo SHA-256 ≠<br/>photo_sha256 inside the signed payload"]:::ok

    classDef ok fill:#e6f6ec,stroke:#2f855a,color:#22543d;
    classDef bad fill:#fde8e8,stroke:#c53030,color:#742a2a;
```

`npm run tamper` runs all three, printing the chain state before and after each.

---

## 6. System architecture

Zero dependencies — Node 22's standard library only. No framework, no bundler, no `node_modules`.

```mermaid
flowchart TB
    subgraph BROWSER["Browser — server-rendered HTML + vanilla JS"]
        LOGIN["login.html"]
        DASH["dashboard.html"]
        PROJ["project.html · emb.js"]
        LED["ledger.html"]
    end

    subgraph SERVER["Node 22 · node:http — server.mjs"]
        API["src/api.js — routing"]
        AUTH["src/auth.js<br/>scrypt hashes · HttpOnly session cookies<br/>role derived server-side, never from the client"]
        WF["src/workflow.js<br/>transitions · measurements · delay · EOT"]
        GEO["src/geo.js — haversine"]
        EX["src/exif.js — EXIF GPS + capture time"]
        UP["src/uploads.js — content-addressed by SHA-256"]
        DEL["src/delays.js — reason codes · party · excusability"]
        LG["src/ledger.js<br/>appendLedgerEntry() · verifyChain()"]
        AN["src/anchor.js — external chain-tip log"]
    end

    subgraph STORE["Storage"]
        DB[("node:sqlite<br/>projects · approvals · measurements<br/>delay_logs · eot_requests · ledger_seq")]
        FS[("public/uploads/&lt;sha256&gt;.jpg")]
        ANF[("~/.pwd-infra-workflow/anchors.log")]
    end

    BROWSER --> API
    API --> AUTH
    API --> WF
    WF --> GEO
    WF --> EX
    WF --> UP
    WF --> DEL
    WF --> LG
    LG --> AN
    LG --> DB
    UP --> FS
    AN --> ANF
    WF --> DB

    OUT["Simulated smart contract<br/>payment trigger — logged event"]:::sim
    WF --> OUT

    classDef sim fill:#faf5ff,stroke:#6b46c1,color:#44337a,stroke-dasharray: 4 3;
```

The database lives outside the repo (`~/.pwd-infra-workflow/app.db`) because the working copy sits
in a OneDrive-synced folder, and a sync client holding handles on the `-wal`/`-shm` side files
produces `SQLITE_IOERR` — or worse, corruption mid-write.
