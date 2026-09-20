# Infraledger — Workflow Diagrams

Seven views of the system: the tender initiation gates that bring a work package into existence,
the execution stage machine (`src/config.js` + `src/workflow.js`), the validation pipeline in
`recordMeasurement()`, the delay/EOT lifecycle (`src/workflow.js` + `src/delays.js`), and the
chain in `src/ledger.js`.

All diagrams are Mermaid and render directly on GitHub.

> **Role:** the Divisional Accountant / FA has been replaced throughout by the
> **DEE — Deputy Executive Engineer**, who conducts the physical test-check of around 30% of the
> work and accords sub-divisional technical approval before the file reaches the EE. Budget
> verification and statutory deductions left the workflow with the Divisional Accountant.

---

## 1. Tender initiation — from need to published ITT

Everything upstream of a contractor existing. The package is defined, sanctioned and authorized
before an Invitation to Tender goes out. **Bidding itself is out of scope** — the flow stops at
publication and resumes at award.

```mermaid
flowchart TD
    NEED(["Work identified<br/>annual plan · public demand · asset condition"]) --> AA

    subgraph DEFINE["1 · Define the procurement package"]
        AA["Administrative Approval (AA)<br/>competent authority sanctions the work<br/>and its indicative cost"]:::gate
        AA --> SCOPE["JE / AE prepare the package<br/>scope of work · site details · drawings<br/>specifications · detailed estimate · BOQ"]
        SCOPE --> REQ["Requirements fixed<br/>completion period · eligibility criteria ·<br/>EMD &amp; security deposit · quality standards ·<br/>penalty and LD clauses"]
    end

    REQ --> SCRUT

    subgraph AUTH["2 · Authorization gates"]
        SCRUT{"DEE scrutiny<br/>sub-divisional technical approval"}:::gate
        SCRUT -- "returned for revision" --> SCOPE
        SCRUT -- "approved" --> TS{"Technical Sanction<br/>EE verifies estimate, rates and<br/>specifications · records budget head"}:::gate
        TS -- "returned for revision" --> SCOPE
        TS -- "no budget" --> HOLD["Package parked<br/>pending budget release"]:::warn
        HOLD -- "budget released" --> TS
        TS -- "sanctioned" --> DOC["Tender document assembled<br/>NIT · ITT · conditions of contract ·<br/>BOQ · drawings · schedule"]
        DOC --> APP{"EE authorises publication<br/>signed with DSC PIN"}:::gate
        APP -- "withdrawn for revision" --> SCOPE
    end

    APP -- "approved" --> PUB["ITT published<br/>tender ID · issue date · last date ·<br/>pre-bid meeting · opening date"]:::ok
    PUB --> LEDGER["appendLedgerEntry('TENDER', …)<br/>package hash · estimate · sanction refs ·<br/>approving officers"]:::ledger

    LEDGER --> GAP(["Bidding, evaluation and award<br/>— outside this system —"]):::out
    GAP --> WO["Work order issued<br/>contractor on record"]:::ok
    WO --> EXEC(["Project enters the execution<br/>workflow at DRAFT"])

    classDef gate fill:#fdf6e3,stroke:#b7791f,color:#744210;
    classDef warn fill:#fdf6e3,stroke:#b7791f,color:#744210;
    classDef ok fill:#e6f6ec,stroke:#2f855a,color:#22543d;
    classDef ledger fill:#e8f0fe,stroke:#2b6cb0,color:#1a365d;
    classDef out fill:#f7fafc,stroke:#a0aec0,color:#4a5568,stroke-dasharray: 5 4;
```

Four authorization steps, deliberately not all held by the same officer: **AA** establishes that
the work should happen, **DEE scrutiny** gives sub-divisional technical approval, **Technical
Sanction** confirms the estimate is sound and records the budget head against it, and only then
can the EE authorize publication — the same DSC-signed action pattern used for final bill approval
downstream. The estimate is written by the JE or AE and sanctioned by the EE on purpose: an
officer who writes an estimate and then sanctions it has sanctioned nothing.

Implemented in `src/tender.js`, with the state machine in `TENDER_TRANSITIONS`
(`src/config.js`) and 18 tests in `tests/tender.test.js`.

---

## 2. The execution stage machine

The linear path, the three rejection edges, and the one gate that cannot be skipped.

```mermaid
stateDiagram-v2
    direction TB

    [*] --> TENDER_INITIATED

    TENDER_INITIATED: TENDER — ITT published, work order issued
    DRAFT: DRAFT — RA Bill Prep
    PENDING_JE: PENDING_JE — e-MB Recording
    PENDING_AE: PENDING_AE — AE Test-Check
    PENDING_DEE: PENDING_DEE — DEE Technical Approval
    PENDING_EE: PENDING_EE — EE Final Approval
    APPROVED: APPROVED
    PAYMENT_TRIGGERED: PAYMENT_TRIGGERED

    TENDER_INITIATED --> DRAFT: work order issued<br/>contractor on record
    DRAFT --> PENDING_JE: CONTRACTOR · submit_ra<br/>RA_SUBMITTED
    PENDING_JE --> PENDING_AE: JE · submit<br/>SUBMITTED
    PENDING_AE --> PENDING_DEE: AE · test_check<br/>TEST_CHECKED
    PENDING_DEE --> PENDING_EE: DEE · tech_approve<br/>TECH_APPROVED
    PENDING_EE --> APPROVED: EE · approve (DSC PIN)<br/>APPROVED
    APPROVED --> PAYMENT_TRIGGERED: EE · trigger_payment<br/>PAYMENT_TRIGGERED

    PENDING_AE --> PENDING_JE: reject — measurement mismatch
    PENDING_DEE --> PENDING_JE: reject — test-check mismatch
    PENDING_EE --> PENDING_JE: reject

    PAYMENT_TRIGGERED --> [*]

    note right of PENDING_AE
        Mandatory gate. The DEE acting on a file
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

## 3. Who may do what, and when

Each lane can only act while the file is on its own desk.

```mermaid
flowchart LR
    subgraph CON["CONTRACTOR — Primary Contractor"]
        C1["Submit RA Bill"]
        C2["Log ground delay"]
        C3["Raise EOT request"]
    end

    subgraph JE["JE — Junior Engineer"]
        J0["Prepare estimate &amp; BOQ<br/>at tender stage"]
        J1["Record geo-tagged e-MB entry"]
        J2["Submit for AE test-check"]
        J3["Log ground delay / raise EOT"]
    end

    subgraph AE["AE / SDO — Assistant Engineer"]
        A0["Compile tender package"]
        A1["Test-check physical measurements"]
        A2["Reject: measurement mismatch"]
        A3["Recommend EOT days"]
    end

    subgraph DEE["DEE — Deputy Executive Engineer"]
        D0["Scrutinise the tender package<br/>before Technical Sanction"]
        D1["Physical test-check, ~30% of the work"]
        D2["Accord sub-divisional<br/>technical approval"]
        D3["Reject: test-check mismatch"]
    end

    subgraph EE["EE — Executive Engineer"]
        E0["Technical Sanction<br/>+ budget head"]
        E1["Approve publication of ITT — DSC"]
        E2["Final bill approval — DSC PIN"]
        E3["Reject"]
        E4["Approve / reject EOT days"]
        E5["Execute smart contract"]
    end

    J0 --> A0 --> D0 --> E0 --> E1
    E1 --> C1 --> J1 --> J2 --> A1 --> D1 --> D2 --> E2 --> E5
    A2 -.-> J1
    D3 -.-> J1
    E3 -.-> J1
    C3 --> A3 --> E4
    J3 --> A3
```

---

## 4. The e-MB capture pipeline

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

## 5. Ground delay and Extension of Time

Deliberately separate from the approval workflow. "Which desk is the file sitting on" is the
corruption signal; "why is the road not getting built" is a different question, and conflating
them is how a system loses the engineers who have to use it.

```mermaid
flowchart TD
    OBS(["Work stalls on site"]) --> LOG["JE or CONTRACTOR logs a delay<br/>category · responsibility · impact_days · evidence"]:::ledger
    LOG --> ST1["delay_log.status = LOGGED"]

    ST1 --> PARTY{"delay_responsibility"}

    PARTY -- EXTERNAL --> EXT["Land acquisition · utility shifting<br/>statutory clearance · court stay<br/>encroachment · law &amp; order · weather"]
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

## 6. The ledger: one chain, five record types

Tender events, approvals, measurements, delay logs and EOT decisions share a single monotonic
`seq` counter, so they form **one** ordered chain rather than five parallel ones.

```mermaid
flowchart LR
    G["GENESIS<br/>prev_hash = 000…0"]:::gen
    B0["seq 1 · TENDER<br/>ITT published"]
    B1["seq 2 · APPROVAL<br/>RA_SUBMITTED"]
    B2["seq 3 · MEASUREMENT<br/>photo_sha256 · lat/lng"]
    B3["seq 4 · APPROVAL<br/>SUBMITTED"]
    B4["seq 5 · DELAY_LOG<br/>LAND_ACQUISITION"]
    B5["seq 6 · APPROVAL<br/>REJECTED — mismatch"]
    B6["seq 7 · EOT_APPROVAL<br/>PENDING_EE"]
    B7["seq n · APPROVAL<br/>PAYMENT_TRIGGERED"]

    G --> B0 --> B1 --> B2 --> B3 --> B4 --> B5 --> B6 --> B7

    B7 --> ANC["anchors.log<br/>chain tip written OUTSIDE the database"]:::anc

    classDef gen fill:#edf2f7,stroke:#4a5568;
    classDef anc fill:#faf5ff,stroke:#6b46c1,color:#44337a;
```

```
hash = SHA256( canonical_json(payload) + prev_hash )
```

Putting the tender package on the same chain is what makes scope creep visible: the published
estimate and BOQ are sealed before a single bill exists, so a later measurement that exceeds the
tendered quantity is checkable against a record nobody can quietly revise.

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

## 7. System architecture

Zero dependencies — Node 22's standard library only. No framework, no bundler, no `node_modules`.

```mermaid
flowchart TB
    subgraph BROWSER["Browser — server-rendered HTML + vanilla JS"]
        LOGIN["login.html"]
        TEND["tender.html<br/>package prep · sanction gates · ITT"]
        DASH["dashboard.html<br/>DEE status view · SLA flags"]
        PROJ["project.html · emb.js"]
        LED["ledger.html"]
    end

    subgraph SERVER["Node 22 · node:http — server.mjs"]
        API["src/api.js — routing"]
        AUTH["src/auth.js<br/>scrypt hashes · HttpOnly session cookies<br/>role derived server-side, never from the client"]
        TND["src/tender.js<br/>package · DEE scrutiny · TS · ITT"]
        WF["src/workflow.js<br/>transitions · measurements · delay · EOT"]
        GEO["src/geo.js — haversine"]
        EX["src/exif.js — EXIF GPS + capture time"]
        UP["src/uploads.js — content-addressed by SHA-256"]
        DEL["src/delays.js — reason codes · party · excusability"]
        LG["src/ledger.js<br/>appendLedgerEntry() · verifyChain()"]
        AN["src/anchor.js — external chain-tip log"]
    end

    subgraph STORE["Storage"]
        DB[("node:sqlite<br/>tenders · tender_events · projects · approvals<br/>measurements · delay_logs · eot_requests · ledger_seq")]
        FS[("public/uploads/&lt;sha256&gt;.jpg")]
        ANF[("~/.pwd-infra-workflow/anchors.log")]
    end

    BROWSER --> API
    API --> AUTH
    API --> TND
    API --> WF
    TND --> LG
    TND --> DB
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

`src/tender.js`, `public/tender.html`, and the `tenders` / `tender_events` tables implement
diagram 1. `tenders` holds current state; `tender_events` is append-only and carries the chain —
a split the delay and EOT tables do not make, which is why their review steps collide on the
primary key.

The database lives outside the repo (`~/.pwd-infra-workflow/app.db`) because the working copy sits
in a OneDrive-synced folder, and a sync client holding handles on the `-wal`/`-shm` side files
produces `SQLITE_IOERR` — or worse, corruption mid-write.
