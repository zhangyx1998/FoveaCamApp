# Split of Work — dispatch & log interface

> **This file is the only planner↔coder interface.** All other
> `docs/refactor/*.md` files are the planner's own tracking — coders do
> not edit them (this supersedes any older instruction to "log under
> Stage 4 in orchestrator.md"). Design specs still live there; active
> instructions below link to them read-only.

## Planner

The planner (Claude session directed by Yuxuan) owns everything about
this effort except writing the implementation itself. **Incoming
planners: read [`planner.md`](./planner.md) first — the full handover
(state, dispatch mechanics, environment gotchas, next actions).**

- **Sequencing & scope.** Decides what work exists, splits it into
  stages/rounds/instructions, orders it against dependencies and
  hardware availability, and keeps each coder's active set small and
  collision-free (the file-ownership table below is the planner's to
  maintain).
- **Specs.** Writes the design record in the planner docs
  (`orchestrator.md`, `synced-capture.md`, `verification-playbook.md`,
  …) and distills it into dispatch-ready instructions here — scope,
  spec pointer, DoD — so coders never have to infer intent.
- **Verification.** Each iteration: checks every coder log **against
  the actual code**, re-runs the standing gates independently (never
  trusts a reported gate), and files defects as findings with severity,
  a concrete failure scenario, and a fix spec. Claimed-but-absent work
  is a finding, not a misunderstanding.
- **Steering & release.** Writes `Steering:` notes under instructions
  that need fixes; releases the next stage/phase only after the current
  one's issues are resolved. Accepted instruction+log pairs are
  archived into the planner docs, then deleted from this file.
- **Escalation to the user.** The planner does not commit (the user
  commits at planner-declared checkpoints), does not run the hardware
  rig, and surfaces contract-level tradeoffs (e.g. preview quality vs.
  transport cost) as explicit user decisions rather than deciding them.

## Protocol

- The planner writes numbered instructions under each role's **Active
  instructions**, each with scope, spec pointer, DoD, and an empty
  **Log:** slot.
- Coders implement **only their active instructions**, then append a
  compact log (≤ 15 lines) under that instruction's **Log:** — what
  landed, gates run with results, deviations from spec, and one-line
  notes for any out-of-scope discovery (do not fix those inline).
- Each iteration the planner verifies logs against code, writes
  **Steering:** notes under the instruction where fixes are needed, and
  releases the next instructions once the current ones are accepted.
  Accepted instruction+log pairs are **deleted** (planner archives what
  matters into the planner docs first) — this file stays short.
- Do not edit: other roles' sections, the protocol/ownership sections,
  or any other `docs/refactor/*` file. When your items are done, stop.

**Dispatch mechanics (switched to Opus 4.8 subagents 2026-07-07, per
user):** workers are **Claude Opus 4.8 subagents** spawned by the
planner via the in-harness Agent tool (`subagent_type: "claude"`,
`model: "opus"`), one persistent agent per role. They share the
planner's filesystem and environment; the planner is notified on each
agent's completion and runs the verification iteration, then continues
the same agent with `SendMessage` (context intact) for the next wave —
a fresh `Agent` call would start cold, so ALWAYS resume via SendMessage
within a round. Each agent is **warmed up before its first task**: a
spawn prompt that onboards from the docs (AGENTS.md + this file + its
role's planner docs) and returns a takeover note the planner checks;
only then does the planner SendMessage the actual instructions. Per
design the docs (this file + the planner docs) are the complete memory,
so a lost agent is re-spawnable from a warm-up. The 2026-07-07 Codex
`gpt-5.5` fleet (and the earlier Sonnet 5 / Codex fleets) are retired;
`scripts/dispatch-worker.sh` is kept only as a fallback host. At most
one agent per role; roles run concurrently (ownership table keeps
domains disjoint). Sandbox: agents write only within the repo; no
network / `npm install` without a planner-logged grant in the
instruction.

**Standing gates (every instruction, unless it narrows them):**
`vue-tsc --noEmit -p tsconfig.json` → 0 errors; `vitest run` all green;
`vite build` fully green; renderer bundle **zero-core**; orchestrator
bundle **zero-Vue**; `core make build` both runtimes when native code is
touched; reader addon `otool -L` shows system libraries only;
`pyfovea/.venv/bin/python -m pytest pyfovea/tests` all green when
pyfovea or the recorder schema is touched; built
preloads pass the **V11 triplet**:
relative-import grep (`(from |require\()"\./`) empty — sandboxed
preloads can't load sibling chunks (V11); content is CJS, never
`import`-style ESM (V11b); zero hits for
`baseURI|import_meta|createRequire` — vite's `import.meta` shim
resolves to the dev-server URL inside preloads (V11c). Tree stays
uncommitted — the user commits at planner-declared checkpoints. Shell
guidance (Sonnet workers share the planner's environment): run gate
binaries from `node_modules/.bin/*` and use `/opt/homebrew/bin/node`
for `core/test` scripts — the bare `node`/`npx` wrappers are broken in
this zsh. Do not run `npm install` or other dependency changes without
a planner-logged handoff.

## File ownership

Exactly one owner per path; touching a file you don't own requires a
planner-logged handoff (ask via your log, don't just edit).

| Path | Owner |
|---|---|
| `app/modules/**`, `app/src/**`, `app/lib/**` (except below) | A |
| `app/orchestrator/**` | A |
| `app/electron/main.ts`, `preload.ts`, `bridge.ts` | A |
| `app/test/**` — suites belong to their feature's owner (precedent: metering/workload-view/SHM suites are C's, the rest A's); the directory itself is shared | shared |
| `app/orchestrator/registry.ts` (Stage 4 complete → back to A; C has metering-wiring write access for C-6 only) | A |
| `app/orchestrator/metering.ts` (new), metering wiring diffs in `registry.ts`/`frame-worker.ts`/`stream-writer.ts` (C-6 duration) | C |
| Window framework: `app/electron/**` (window manager, entries wiring), renderer entry HTMLs, `app/src/windows/**`, `vite.config.ts` renderer entries | A |
| Recorder format bench: `playground/bench-recorder/**` | B |
| Recorder writer: `app/orchestrator/recorder/**` (new) + surgical integration diffs in `stream-writer.ts` / `modules/manual-control/recording.ts` (B-5 duration) + the `@mcap/*` dependency promotion | B |
| Profiler window UI: `app/src/profiler/**` (C-7 duration — C built the metering schema it renders) | C |
| `app/electron/preload-bridge.ts` (bridge impl — MUST stay self-contained per V11; shm-free) | A |
| `app/electron/preload-renderer.ts`, `preload-profiler.ts` | C |
| SHM blocks in `lib/orchestrator/client.ts` + `protocol.ts` (`shm` payload variant), SHM OSD in `StreamView` | C (A owns the rest of those files) |
| `core/include/ShmRing.h`, `core/src/ShmRing.cpp`, reader addon target, `core/test/08-shm-ring.ts` | C |
| `lib/orchestrator/viewer-contract.ts` — THE pinned A↔C contract; planner arbitrates changes | shared (planner) |
| `app/orchestrator/viewer/**`, `sessions/viewer.ts` | C |
| `app/src/windows/ViewerWindow.vue`, `app/electron-builder.yml` | A |
| `pyfovea/**` | B |
| `core/**` (everything else), `firmware/**`, protocol v2 host+MCU | B |
| `docs/refactor/*` (all files but this one), this file's non-Log text | planner |

**OPTIMIZATION SURVEY — shared instruction text for A-14/B-7/C-9 (user
directive 2026-07-07):** survey YOUR OWNED SURFACE (ownership table)
for: (1) **repetitive logic patterns** — near-duplicate code that wants
a shared helper or abstraction; (2) **long, wordy variable/function
names** — propose concise alternatives that fit this project's voice
(sample the best existing names as the target register; a rename map is
a fine proposal format); (3) **better-fit solutions** — places where a
different structure/API/algorithm would serve the project's actual use
case better, INCLUDING large breaking changes if they steer the
codebase to a better overall state. Write proposals to
`docs/refactor/proposals/<ROLE>.md` (yours for this round), ranked by
value, max ~15, each with: id (`<ROLE>-P<n>`), location(s),
current → proposed (sketch, not implementation), **category:
non-breaking | breaking**, rationale tied to a real cost (duplication
count, call-site count, past bugs in that area), effort (S/M/L), risk.
NO CODE CHANGES in this phase. Triage rule (planner-executed):
non-breaking gets green-lit directly; breaking goes to the user.
Log a 3-line pointer under your Log: slot when done.

## Coder A — App & sessions (renderer, orchestrator JS, Electron shell)

Owns all non-SHM application code: feature modules
(`contract/session/index.vue`), orchestrator runtime/sessions/store-hub,
shared app libs, Electron main/preload (non-SHM), Vue surfaces, app
tests. Boundary rules to preserve: hardware/vision/control stays
orchestrator-side; renderer stays a thin session client, zero-core;
orchestrator-reachable code stays Vue-free; never mark
hardware-dependent behavior verified without a real rig run.

### Active instructions

- **A-16 — optimization wave 2 (green-lit non-breaking set; triage:
  docs/refactor/proposals/TRIAGE.md; full sketches in
  docs/refactor/proposals/A.md).** Implement, in order:
  1. **A-P9-consistency-followup is DONE (wave 1)** — skip; start at P4.
  2. **A-P4** (marker-calibration session helper) — extract shared
     primitives for the L/C/R `MarkerTracker` triple, `DetectionView`
     publishing, and `setTargetId` updates used by `calibrate-extrinsic`,
     `calibrate-drift`, `calibrate-distortion`. SMALL primitives, not a
     framework (same discipline as A-P3): each session keeps its own
     intrinsic/extrinsic ownership and actuation mode; the helper only
     removes the tracker-triple + detection-publish + target-id
     boilerplate. Keep/extend each calibration session's tests.
  3. **A-P8** (window class table) — add a single `WINDOWS` metadata
     table (class, entry, singleton/dedupe key, counts-for-welcome,
     exclusivity, preload, sandbox, default bounds, restore params) that
     `windows.ts`/`main.ts`/`window-manager.ts`/`window-manifest.ts`
     derive from. Electron-only `BrowserWindow` options stay main-side
     behind a pure-metadata→options adapter. Do NOT regress the welcome
     rule, singleton/dedupe, or manifest restore — the window-manager +
     window-manifest suites must stay green and gain a table-coverage
     test.
  4. **A-P10** (typed bridge IPC registry) — one typed registry of
     channel name → arg tuple → return type; preload wrappers and main
     handlers derive/validate from it. **HARD CONSTRAINT: V11 triplet.**
     The registry must be a plain shared TS type/const module that the
     self-contained CJS preload bundle can inline — no `import.meta`, no
     sibling-chunk imports, no `createRequire`. Re-run the triplet grep
     on the emitted `preload-*.cjs` yourself and paste results.
  5. **A-P11** (manage-cameras property schema) — a schema of camera
     controls (getter/setter key, availability key, range key, auto-mode
     key, units, formatter, persistence) that the contract type, native
     read guards, `CameraConfig.vue`, and reset logic consume. MUST
     preserve the existing `safe()` behavior (native getters may throw /
     be unavailable). Bonus if welcome-window annotations can reuse the
     schema's labels/formatters, but don't block on it.
  6. **A-P13** (activation errors as session telemetry) — a standard
     additive `error`/`status` telemetry convention (or runtime `fail(reason)`
     helper) seeded to new subscribers, so failed `activateSession()` is
     user-visible instead of stderr-only. Additive to contracts; UI
     adoption can be per-module (wire at least one module, e.g.
     manage-cameras or tracking-single, as the reference consumer).
  - Scope guard: all five are tagged **non-breaking** — none may change
    a wire contract shape (that's A-P7/A-P12, a later breaking wave).
    A-P4/P8/P11 are behavior-preserving refactors: keep or extend the
    tests that cover them. Any breaking temptation → stop and log, don't
    do it inline.
  - DoD: standing gates (vue-tsc 0; full vitest green; vite build +
    V11 triplet on emitted preloads; renderer zero-core; orchestrator
    zero-Vue). Per-item log ≤ 15 lines: what landed, gates with numbers,
    deviations, out-of-scope notes.
  - Log:

## Coder B — Native core, protocol & firmware

Owns `core` native code (except the SHM substrate), `firmware/**`, and
the protocol-v2 host+MCU surface — the synced-capture lineage: bench
readiness, P3.1a/P4/P5 when hardware returns, FIN-trace diagnostics,
tracker/controller/dispatcher native work. The former "finisher" role is
retired: each coder fixes planner findings in their own area; quality
control is the planner's review loop.

### Active instructions

- **B-9 — optimization wave 2 (green-lit non-breaking set; triage:
  docs/refactor/proposals/TRIAGE.md; sketches in
  docs/refactor/proposals/B.md).** Implement, in order:
  1. **B-P1** (single PixelFormat/Dtype registry) — collapse the
     hand-maintained C++ enum/switches, TS unions, Python dtype maps,
     Bayer lists, `significantBits`, and `isPacked` into ONE declarative
     source table that generates (or is the checked-in single source
     for) the C++ tables, TS types, and Python maps. Reuse B-P2/B-P3's
     `docs/schema/` lineage — the codec fixtures + `fovea.ts` are already
     the schema-as-code home; extend that, don't start a parallel one.
     **Generator stays trivial and its output is checked in** (triage
     rule): no build-time codegen step wired into `core make build` or
     vite. Preserve every export name + the 12p-unpack comments (B-P1
     risk note). Kill the stale `CAPACITY = 8` d.ts comment while here.
  2. **B-P4** (bench drives the production writer) — refactor
     `playground/bench-recorder/` into a thin harness around the
     PRODUCTION recorder writer/worker (`app/orchestrator/recorder/`),
     with compression knobs injected behind a bench-only interface.
     Compression must NOT become a production default. Re-run the bench
     smoke and paste the headline numbers (they should still show the
     single-writer bottleneck; if they move materially, that's a finding).
  3. **B-P10** (streaming pyfovea telemetry join) — add
     `iter_frames_streaming()` as an ADDITIVE API that yields file-order
     frames with bounded telemetry state (and works on crash-truncated
     files without whole-file materialization). Do NOT change the
     default `iter_frames()` order or its joined-extras guarantee —
     triage pinned this as additive-only. New tests: large-ish synthetic
     file + the existing crash fixture, asserting bounded memory
     behavior (e.g. it yields before consuming the whole file).
  - Scope guard: all three tagged non-breaking. B-P1 must keep emitted
    API/enums byte-compatible; B-P10 must stay additive. Firmware is
    NOT in this wave (B-P8/P9 already landed; B-P6/P11/P13 are
    deferred/user-gated).
  - DoD: standing gates incl. `core make build` both runtimes (B-P1
    touches native), `otool -L` system-libs-only on the reader if
    rebuilt, **pyfovea pytest** (B-P10), and the cross-language codec
    fixtures still pass in C++/TS/Python (B-P1 must not drift them).
    Per-item log ≤ 15 lines with gate numbers.
  - Log:
- **(B-5 accepted & archived 2026-07-06 → recorder-container.md §2b.)**

## Coder C — SHM frame path (end-to-end)

Sole owner of Stage 4: ShmRing substrate, reader addon, registry
producer path, preload/client SHM transport, SHM OSD, and
their tests. Absorbs the SHM follow-ups previously listed under Coder B
— including the ping-pong pool. Hard rules: SHM is the canonical preview
transport where eligible; descriptors ride the existing Channel machinery;
reader addon never links OpenCV/Aravis/GLib/libusb; scope is
transport-only preview frames (no processed/capture/raw frames without
planner dispatch); no PB2/perf claims without a live display+cameras
session.

### Active instructions

- **C-standby note.** C-1/C-2 were planner-accepted 2026-07-06 and
  archived (orchestrator.md §6 + §7.1 Stage 4).
- **(C-4 accepted & cleared 2026-07-06.)**
- **C-11 — optimization wave 2 (green-lit non-breaking set; triage:
  docs/refactor/proposals/TRIAGE.md; sketches in
  docs/refactor/proposals/C.md).** Implement, in order:
  1. **C-P2** (extract the renderer SHM transfer pool out of
     `client.ts`) — move the ~100 lines of ping-pong pool state + message
     types into `app/lib/orchestrator/shm-client.ts` with a small API
     (`read(payload)`, `release(payload)`, `dispose()`, stats).
     **MessagePort transfer ownership is the regression risk** — pin
     tests for buffer return on: success, null result, timeout, and
     stale/late response. Behavior-identical to today.
  2. **C-P4** (shared native read TU) — factor the reader addon's
     mapping / header validation / slot addressing / seqlock read logic
     into ONE libc-safe `ReadMapping`/`readLatestInto` compiled into both
     the core target and the reader addon. **HARD: the shared TU must
     stay system-library-only** — no N-API, OpenCV, Aravis, GLib, libusb.
     Re-run `otool -L` on the rebuilt reader and paste it (self +
     libc++/libSystem only). Keep the V8/V9 fences + meta-copy-timing +
     retry cap intact — the whole point is one home for that logic.
  3. **C-P7** (stream truncated viewer playback) — replace
     `TruncatedSource.messages()`'s scan-then-store-array with an async
     iterator that yields records as the scan progresses (or a one-time
     recovered-offset index). Bounded memory on large crash artifacts.
     Keep the footerless-recovery contract + `truncated` badge behavior;
     the viewer test must still pass and gain a bounded-memory assertion.
  4. **C-P9** (explicit SHM read/pool telemetry) — expose a small
     `shmReads` workload/stat block (timeout/null/allocation counts,
     read latency) + OSD fields, built on the C-P2 pool module and the
     metering schema. **Meters observe only, never gate reads** (PB3/
     metering hard rule). Additive to `perfSnapshot`.
  5. **C-P11** (viewer file-open dedupe in the session layer) —
     `open(path)` returns the existing fileId for the same canonical
     path instead of allocating a new source/player/topics. Triage
     ratified this as documented dedupe semantics (matches the
     one-window-per-file product rule). **This touches the pinned
     `viewer-contract.ts` — the contract note is planner-arbitrated:
     propose the exact wording in your log and DO NOT change close/
     restore semantics without it.** Coordinate with A's viewer window
     (dedupe already exists at the shell layer; you're adding it at the
     session layer — they must agree on fileId reuse).
  6. **C-P6** (single decode schema, conformance side — CROSS-ROLE with
     B-P1). B owns the format facts + the single source table (B-P1
     extends `docs/schema/`); YOU own the **TS decode conformance**:
     `viewer/decode.ts` + `app/lib/util/dtype.ts` consume the shared
     table (or a conformance test asserts they match it), so viewer
     display and pyfovea training decode can't drift. **Do this AFTER
     B-P1 lands its table** (sequence with B — log a note if B isn't
     ready and I'll re-order). No metadata-name changes (that would be
     breaking); tests/helpers only.
  - Scope guard: all six tagged non-breaking (C-P2/P10-style aliasing
    already done in wave 1; here keep exported shapes stable). C-P11's
    contract wording and C-P6's cross-role sequencing are the two
    planner-touch points — surface them in your log, don't decide them
    solo.
  - DoD: standing gates; `core make build` both runtimes + `otool -L`
    on the reader (C-P4); full vitest incl. the viewer + shm suites;
    `08-shm-ring.ts` still passes; V11 triplet if any preload byte
    changes. Per-item log ≤ 15 lines with gate numbers.
  - Log:

- **(history) C-6 — workload metering core (accepted; spec:
  docs/refactor/workload-metering.md — read it fully first).**
  - `app/orchestrator/metering.ts`: the `Workload` meter per §2 —
    `registerWorkload(name, {inputs, outputs})` returning
    `{ingest, begin/end (or measure), emit, drop, dispose}`;
    utilization = busy-fraction per wall-clock window; rates via
    T10-style window bookkeeping (derived, never assumed); drops/
    coalescing first-class. Vue-free (`rolling.ts` lineage).
  - Adopt in the first citizens you own wiring access to (ownership
    table): registry preview loop (per serial), `frame-worker` gates,
    shm writers (per topic ring), `stream-writer` recorder worker.
  - Export: `system.perfSnapshot` gains an additive `workloads` key;
    live telemetry at the existing 1 Hz throttle. Document the exact
    snapshot shape in your log (the profiler UI lands in a later
    round — schema stability matters more than looks).
  - Harness: fake-timer unit tests for utilization/rate/drop math +
    one integration-style test through a fake workload.
  - DoD: standing gates (incl. V11 triplet — you're not touching
    preloads, but run it); zero behavior change to the metered paths
    (meters observe, never gate).
  - Log: NEW `app/orchestrator/metering.ts` — `registerWorkload(name,{inputs,outputs})`
    → `{ingest,emit,drop,begin,end,measure,dispose}`; T10-style cumulative window
    (mirrors `allFrameStats`). Snapshot: `{name, window:{startedAt,snapshotAt,uptimeMs},
    utilization (busyMs/uptimeMs, ≤1), busyMs, inputs/outputs:{[n]:{count,ratePerSec}},
    drops:{total,ratePerSec,byReason}}`; `allWorkloadSnapshots()`→`Record<name,_>`.
    Full lifecycle wired in `registry.ts` (`registry:<serial>`, camera/shm/view,
    begin/end around convert+publish) and `stream-writer.ts` (`recorder:<name>`,
    frame/written, drop backpressure+failed). `frame-worker.ts` self-registers
    per instance (auto id or `opts.name`) + additive `dispose()`, but session.ts
    call sites (A-owned) aren't wired to name/dispose it yet — follow-up, not
    fixed inline. **Handoff:** splicing `workloads: allWorkloadSnapshots()` into
    `system.perfSnapshot` + `PerfSnapshot` type needs `sessions/system.ts` +
    `lib/orchestrator/contracts.ts` edits (both A-owned) — not done this round.
    Meters never throw (disposed handles inert; dup-name register warns+replaces).
    Gates: vue-tsc 0 err; vitest 97/97 (14 new, fake-timer math + 1 integration
    test); vite build green; V11 triplet clean; orchestrator bundle 0 Vue hits.
- **(history)** C-5 planner-accepted 2026-07-06 — archived to
  orchestrator.md §6/§7.1.
- **C-3 (held).** PB2 live measurement (orchestrator.md §7.1 Stage 4
  Round C) — needs display + cameras and planner acceptance of C-1/C-2
  first. Do not start.
  - Log:
