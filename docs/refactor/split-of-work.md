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

**Dispatch mechanics (switched BACK to Codex 2026-07-07, per user):**
workers are **Codex `gpt-5.5` sessions at high reasoning effort**
(pinned via `-c` in the script), launched headless by the planner via
`scripts/dispatch-worker.sh <A|B|C> ["note"]` in a background shell —
the planner is re-invoked on exit and runs the verification iteration.
Sessions are persistent per role (`.worker-logs/session-<role>.id`;
delete to force a cold start at stage boundaries); resumes send a
short steering-first re-entry prompt. Sandbox: workspace-write (repo-
confined writes, no network — dependency changes need an explicit
planner grant in the instruction). The 2026-07-06 Claude Sonnet 5
subagent fleet is retired; its in-harness sessions are not
transferable — per design, the docs (this file + the planner docs) are
the complete memory, and each Codex session was warmed up 2026-07-07
with an onboarding read-through + takeover note. At most one session
per role; roles may run concurrently (ownership table keeps domains
disjoint); concurrent-log clobbers get restored from transcripts.

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

- **A-15 — optimization wave 1 (green-lit set; triage:
  docs/refactor/proposals/TRIAGE.md — read it, your proposals were
  accepted with noted edits).** Implement, in order: **A-P2**
  (tracking-single display vision onto frame-workers — named meters,
  idle cancellation, drain ordering exactly like manual-control),
  **A-P3** (shared fovea/triple pipeline primitives — SMALL primitives,
  not a framework, per your own risk note), **A-P5** (`useFrames` /
  `useDynamicFrame` helpers, adopt in at least 3 call sites), **A-P9**
  (app-registry consistency test; KEEP the explicit loader map),
  **A-P14** (rename map MINUS `activeSubscribers` and
  `telemetrySnapshot` — vetoed). Wave 2 (P4, P8, P10, P11, P13) comes
  after this lands. DoD: standing gates; every behavior-carrying
  refactor keeps or extends its tests; logs per item.
  - Log: A-P2: tracking-single center/L/R display vision now uses named
    frame workers (`tracking:center`, `tracking:fovea:{L,R}`) with idle cancel.
    A-P3: added small Vue-free `fovea-pipeline` primitives; adopted in
    tracking/manual/disparity; new primitive tests.
    A-P5: added `useFrames`/`useDynamicFrame`; adopted in manual,
    tracking, disparity, calibrate-distortion, welcome.
    A-P9: added app-registry consistency test; explicit loader map retained.
    A-P14: approved local renames landed; vetoed runtime names untouched.
    Gates: vue-tsc 0; vite build green; renderer native-core/orch Vue/V11 clean;
    focused A tests 17/17. Full vitest 173/174: out-of-scope
    `test/codec-fixtures.test.ts` 12p nibbles mismatch (`bc3a12569478`
    vs expected `bc3a12364778`) from concurrent codec work.
- **A-14 — optimization survey (see the shared OPTIMIZATION SURVEY
  spec above).** Your surface: `app/modules/**`, `app/src/**`,
  `app/lib/**` (minus C's shm blocks), `app/electron/**`,
  `app/orchestrator/**` (minus C's shm/viewer/metering files),
  `app/windows/**`. Extra attention: the window framework and modules
  grew fast across Stage 5 — session.ts files likely share
  lease/drain/telemetry boilerplate; StreamView/FrameView props have
  accreted; check for repeated `useSession` wiring patterns.
  - Log: Warm-up takeover note (A-standby slot absent; A-14 not started).
    Read AGENTS.md, full split-of-work, multi-window.md,
    workload-metering.md, and skimmed orchestrator.md §§3/4/6.
    Current state: migration complete; shm canonical for eligible previews;
    passive subscriptions fixed V12; GUI/hardware smoke remains pending.
    Stage 5 landed: window manager/welcome/projection/state-in-URL/HMR
    boundary/preload V11 fixes, workload export/call-site naming, profiler UI.
    A-14 read: survey only, no code; focus app/session boilerplate,
    window-framework growth, StreamView/FrameView prop accretion, useSession
    wiring, and better-fit breaking options; proposals go to
    docs/refactor/proposals/A.md when dispatched.
    A-14 survey landed in docs/refactor/proposals/A.md: 14 ranked proposals
    across sessions, frame/view UI, windows, bridge IPC, contracts, and naming.
    Gates: vue-tsc 0 errors; vitest 163/163; vite build green; renderer
    native-core grep clean; orchestrator Vue grep clean; V11 triplet clean.

## Coder B — Native core, protocol & firmware

Owns `core` native code (except the SHM substrate), `firmware/**`, and
the protocol-v2 host+MCU surface — the synced-capture lineage: bench
readiness, P3.1a/P4/P5 when hardware returns, FIN-trace diagnostics,
tracker/controller/dispatcher native work. The former "finisher" role is
retired: each coder fixes planner findings in their own area; quality
control is the planner's review loop.

### Active instructions

- **B-8 — optimization wave 1 (green-lit set; triage:
  docs/refactor/proposals/TRIAGE.md).** Implement, in order: **B-P2**
  (cross-language 12p test vectors — fixture set consumed by C++/TS/
  Python suites; coordinate file location with C's conformance side:
  put fixtures under `docs/schema/` or `pyfovea/tests/fixtures/codec/`
  — your call, log it), **B-P3** (schema-as-code constants, TS +
  generated-or-mirrored Python, bench renamed onto the real names),
  **B-P7** (chunked host serial RX; byte-level trace preserved behind
  a verbosity flag; per-packet summaries default). Check whether a
  local firmware compile works (`pio run` or the repo's documented
  path): if YES, also do **B-P8** + **B-P9** (compile gate = your
  DoD); if NO, log that and skip — they defer to the bench era. Wave 2
  (B-P1 registry, B-P4 bench-on-production-writer, B-P10 streaming
  reader) after this lands. DoD: standing gates incl. pyfovea suite.
  - Log: B-P2 landed: shared 12p vectors in `docs/schema/codec/`, C++
    `Codec/Packed12.h`, native Frame uses it, C++/TS/pyfovea fixture tests.
    B-P3 landed: schema constants in `docs/schema/fovea.ts`, recorder re-export,
    mirrored `pyfovea.schema`, production writer + converter + bench use real
    `.fovea` schema names/encodings/metadata; bench smoke OK.
    B-P7 landed: host serial rx reads 256-byte chunks, still feeds COBS per byte;
    byte trace remains `VERBOSE`, packet summaries unchanged.
    B-P8/B-P9 landed after pre-edit firmware compile proved local toolchain:
    firmware PendingAction helper + fixed Ring queue, behavior unchanged.
    Gates: vue-tsc 0; vitest 174/174; pyfovea 28/28; vite build green;
    core clean build Node+Electron green; test build + packed12/cobs green;
    renderer core grep/orch Vue grep/V11 triplet clean; reader otool system-libs only.
    Deviation: final post-edit firmware compile blocked — sandbox denied
    `~/.platformio`, escalated rerun rejected by usage limit; no hardware/GUI run.
- **B-7 — optimization survey (see the shared OPTIMIZATION SURVEY
  spec above).** Your surface: `core/**` (minus C's ShmRing/reader),
  `firmware/**`, `pyfovea/**`, `app/orchestrator/recorder/**`,
  `playground/bench-recorder/**`. Extra attention: core's
  convert/PixelFormat tables accreted cases across 12-bit work; the
  recorder worker + bench share synthetic-frame and protocol logic;
  firmware Streams/Capture grew under v2 — flag duplication between
  host and MCU packet handling if any.
  - Log: Warm-up takeover only; B-7 survey not started, no code/gates.
    Read AGENTS.md, full split-of-work, recorder-container.md end to end,
    synced-capture status + §9, and orchestrator.md §§3/6.
    Current B state: synced-capture accepted through T6/T8; rig-gated queue is
    bench→flash→P4 wiring→P5, with FIN root cause waiting for trace bench.
    Schema owned: `.fovea` MCAP; `x-fovea-raw` stream channels keep raw packed
    bytes + `dtype/shape/pixelFormat/significantBits/channels`; JSON telemetry.
    Timestamps are monotonic ns with wall-clock anchor; footerless streaming recovery is required for viewer + pyfovea.
    B-7 read: proposals to `docs/refactor/proposals/B.md`; focus convert/PixelFormat,
    recorder/bench frame logic, pyfovea decode lineage, and host↔MCU protocol duplication.
    B-7 survey landed in docs/refactor/proposals/B.md: 14 ranked proposals
    across PixelFormat/dtypes, 12p, recorder schema/bench, protocol/firmware, pyfovea, and naming.
    Gates: vue-tsc 0; vitest 163/163; pyfovea 28/28; vite build green; renderer core grep clean; orchestrator Vue grep clean; V11 triplet clean; native/otool skipped (docs-only).
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
- **C-10 — optimization wave 1 (green-lit set; triage:
  docs/refactor/proposals/TRIAGE.md — accepted with noted edits).**
  Implement, in order: **C-P3** (shared window/rate bookkeeping —
  output shapes unchanged), **C-P5** (`readSnapshot()` + deprecated
  `view()` alias, call sites steered), **C-P8** (process-local
  topic-key collision registry that THROWS on live collision; test
  it), **C-P10** (rename map MINUS `latestBefore` and
  `workloadSnapshot` — vetoed; alias-stage the exported ones), **C-P1**
  (the frame descriptor/meta normalizer — one merge policy, adopted at
  all 5 sites; this is the V9/V13-class guard, test meta precedence
  explicitly). Wave 2 (C-P2 pool extraction, C-P4 shared native read
  TU, C-P7 streaming recovery, C-P9 shm telemetry, C-P11 dedupe
  semantics, C-P6 conformance with B) after this lands. DoD: standing
  gates; buffer/meta tests as noted per item.
  - Log:
    C-P3: added `@lib/orchestrator/stats`; Channel + Workload rates share it,
    with unchanged output shapes.
    C-P5/C-P8: `ShmSlot.readSnapshot()` + deprecated `view()` alias; `topicKey()`
    throws on process-local hash collisions; known-collision/native tests added.
    C-P10: C-owned call sites moved to new names; vetoed names untouched; aliases
    kept for existing A/B imports.
    C-P1: new `frame-payload` helper adopted in protocol/frame-transport/
    preload/client/fake transport; meta precedence test added.
    Gates: vue-tsc 0; C-focused vitest 31/31; vite build green; core make build
    Node+Electron green; core/test tsconfig 0; bundle/V11/otool checks clean.
    Full vitest 173/174 blocked by out-of-scope untracked codec test mismatch
    (`bc3a12569478` vs `bc3a12364778`); SHM smoke blocked by sandbox and
    escalation rejected by usage limit, so not completed.
- **C-9 — optimization survey (see the shared OPTIMIZATION SURVEY
  spec above).** Your surface: shm path end-to-end (`ShmRing.*`,
  reader addon, `frame-transport.ts`, preload-renderer shm side,
  client pool), `metering.ts`, `orchestrator/viewer/**` +
  `sessions/viewer.ts`, `viewer-contract.ts`, shm blocks in
  client/protocol/StreamView. Extra attention: the frame path now has
  THREE meta-merge sites (writer publish, preload readInto, client
  materialize) — check for unifiable descriptor handling; decode.ts
  vs pyfovea dtypes.py vs stream-decoder lineage duplication is
  cross-role — propose, note the seam.
  - Log:
    Warm-up takeover only (2026-07-07); C-9 survey NOT started and no gates run per planner note.
    SHM state: canonical pixel transport for eligible previews and session frames; Channel carries descriptors only, reader addon remains minimal/system-lib-only, renderer materializes via ping-pong buffers.
    Cage/seqlock lessons to preserve: V8 fences around writer data and reader copy; V9 meta copied inside validated window; V13 JS `view()` is a cage read snapshot, writes must use native `write()`/`copyTo()`.
    Metering state: `Workload` abstraction landed/exported in `perfSnapshot.workloads`; registry, frame-worker, shm writer/recorder paths observe ingest/emit/drop/busy without gating behavior.
    Viewer data layer: accepted `viewer` session replays `.fovea` through `fr:viewer:<fileId>:<channel>` SHM topics under the pinned `viewer-contract.ts`, with indexed read plus footerless fallback.
    Recorder context: MCAP `.fovea` schema pinned in recorder-container §2b; viewer/Python readers must preserve raw bytes, metadata decode props, telemetry, monotonic ns timestamps, and streaming recovery.
    Held queue: C-3 PB2 live measurement still waits on display+cameras; C-9 optimization survey awaits separate dispatch.
    C-9 survey landed in `docs/refactor/proposals/C.md`: 12 ranked proposals across descriptor/meta normalization, SHM pool/native reader, metering, viewer fallback, codec schema, topic keys, and naming.
    Gates: vue-tsc 0; vitest 163/163; vite build green; renderer core grep clean; orchestrator Vue grep clean; V11 triplet clean; reader addon otool clean (self + libc++/libSystem only).
    Skipped core make build + pyfovea pytest because this was docs-only: no native, pyfovea, or recorder-schema files touched; no GUI/hardware claims.

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
