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

**Dispatch mechanics — DUAL FLEET (gpt-5.5 active for implementation +
Opus 4.8 warm reserve; 2026-07-07, per user).** Two worker fleets are
kept warm so the planner can switch a role between them wave-to-wave:
- **gpt-5.5 (Codex) — OUT OF USAGE as of 2026-07-07 (per user); Opus 4.8 is
  now the SOLE active fleet, all three roles.** When quota returns it resumes
  as an available fleet. Dispatched via
  `scripts/dispatch-worker.sh <A|B|C> ["note"]` in a background Bash
  (the planner is re-invoked on exit); first run per role warms up from
  a fresh session (kickoff onboards from AGENTS.md + this file), later
  runs `codex exec resume` the same session id (`.worker-logs/
  session-<role>.id`) with a steering-first re-entry. gpt-5.5 at high
  reasoning effort, model + effort pinned in the script. Sandbox:
  workspace-write, no network.
- **Claude Opus 4.8 subagents — the WARM RESERVE.** One persistent
  in-harness Agent per role (`subagent_type: "claude"`, `model:
  "opus"`), resumed via `SendMessage` (context intact — a fresh `Agent`
  call starts cold). Parked/resumable between waves; the planner can
  hand a role's next wave to Opus instead of gpt-5.5 when it wants the
  switch. Parked agent ids: A `ac10aaf887cee3837`, B `a12135ab7a5a9139e`,
  C `a902c02a702cffe03`.
Both fleets share the planner's filesystem/environment; the docs (this
file + planner docs) are the complete memory, so either fleet is
re-warmable from current docs and a role can move between them without
context loss. Each worker is **warmed up before its first task** (an
onboarding read-through + takeover note the planner checks) then fed its
active instructions. At most one active worker per role at a time; roles
run concurrently (ownership table keeps domains disjoint). Sandbox:
workers write only within the repo; no network / `npm install` without a
planner-logged grant in the instruction.

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
| `core/include/ShmRing.h`, `core/include/ShmLayout.h`, `core/src/ShmRing.cpp`, reader addon target, `core/test/08-shm-ring.ts` + the WS1 pipe substrate `core/include/Pipe.h`, `core/src/Pipe.cpp` and its `core.Pipe` NAPI target (C-16 grant 2026-07-07 — SHM frame path is C's domain end-to-end) | C |
| `lib/orchestrator/viewer-contract.ts` — THE pinned A↔C contract; planner arbitrates changes | shared (planner) |
| `app/orchestrator/viewer/**`, `sessions/viewer.ts` | C |
| `app/orchestrator/pipe-session.ts`, `app/lib/orchestrator/pipe-consumer.ts` + `shm-client.readPipe` block + the pipe handler in `preload-renderer.ts` (WS1 pipe stack — C-17 grant 2026-07-07; under A's dirs by default but C-owned) | C |
| `core/include/ThreadMeter.h`, `core/src/ThreadMeter.cpp` (native free-thread instrumentation meter — the C++ mirror of the C-18 `Workload` meter; probed out-of-loop; reused by 1d KCF thread) + the producer/capture-thread additions in `Pipe.h`/`Pipe.cpp` (C-19 grant 2026-07-07) | C |
| `app/src/windows/ViewerWindow.vue`, `app/electron-builder.yml` | A |
| `pyfovea/**` | B |
| `core/**` (everything else), `firmware/**`, protocol v2 host+MCU | B |
| `docs/refactor/*` (all files but this one), this file's non-Log text | planner |
| `docs/schema/**` (schema-as-code single source, incl. `pixel-formats.ts`) | B |
| `app/lib/util/dtype.ts` (C-P6 handoff CLOSED 2026-07-07 — reverted to A; now consumes `docs/schema/pixel-formats.ts`) | A |

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

- **(A-18 wave-3 accepted & archived 2026-07-07 → proposals/TRIAGE.md.)**

- **(A-19 wave-4 accepted & archived 2026-07-07 → proposals/TRIAGE.md.)**

- **(A-20 refactor wave-1 accepted & archived 2026-07-07 → refactor-plan.md.)**

- **(A-21 refactor wave-2 accepted & archived 2026-07-07 → refactor-plan.md.)**

- **(A-22 WS4-4b write-path accepted & archived 2026-07-07 → refactor-plan.md.)**

- **A-23 — keep-busy loop toward the milestone (user 2026-07-07; posture: break
  freely within your surface, converge by the milestone).** Iterative survey-and-
  implement on YOUR surface, HIGH VALUE not churn. Priority order:
  1. **A-P1 — resource-scoped session lifecycle (the breaking refactor, now
     GREEN-LIT).** It's A-owned and on the convergence path (WS2 foundation); take
     it on directly rather than only prepping around it. Build on your A-R2-P1
     `DisposerBag`/lease substrate. Break internal session APIs as needed; keep it
     converging (your own gates green by end of the batch, or flag convergent WIP).
  2. **Test coverage on the newly-landed refactor substrate** (de-risks the rig
     pass): A-20/A-21 window-ownership/cascade (owner/childrenOf/onOwnerClose/keyed
     toggle/debug cascade/planFromManifest drop) + the A-22 frame↔voltage write
     path (`recording.ts` fin-averaged vs live-snapshot, `deps.foveaBinding`).
  3. **Dedup / naming / structure** on A-owned files — opportunistic.
  - **RULES (loosened).** You MAY break things WITHIN your own surface
    (restructure, break internal APIs, behavior-change your own modules) when it's
    higher-value and converges by the milestone. **PROPOSE-first only for breaks
    that cross a boundary others depend on:** the pinned `viewer-contract.ts`, wire
    contracts consumed by other roles, on-disk/persisted-key formats — those I
    sequence (convergence management, not fear). **COLLISION EXCLUSIONS still
    hold** (reserved for in-flight cross-role work): do NOT touch
    `app/orchestrator/registry.ts` or any camera→SHM write path (C's real-1c seam),
    `app/orchestrator/metering.ts` / `app/src/profiler/**` (C-18), or C-owned
    files. A C-18 handoff for a `system.ts`/`contracts.ts` workloads-type field you
    MAY do.
  - **Cadence.** Implement a small batch → run gates → append a dated sub-log
    entry under A-23 → continue with the next batch. Keep going until I post a
    Steering: note ending the loop (the milestone). If you run out of clearly-
    non-breaking high-value work, STOP and say so — do NOT invent churn.
  - **DoD each batch.** vue-tsc 0; `vitest run` green; `vite build`; renderer
    zero-core; orchestrator zero-Vue; V11 if a preload is touched. No hardware
    claim. Note any surface needing user visual check.
  - Log:
    - **2026-07-07 batch 1 (test coverage — A-21 substrate gaps).** Filled two
      untested paths: (a) `planFromManifest` drop-on-restore for owner-bound
      cascade windows — NEW window-manifest tests (debug dropped beside an app;
      debug-only manifest → just welcome). (b) window-manager: one debug window
      per session all cascading with the owner app (distinct keys → 2 children →
      both destroyed on app close); toggleDebug with no app window spawns an
      ownerless non-cascading debug window (defensive). Gates: vue-tsc 0; vitest
      248/248 (+5); (test-only — no bundle change). No behavior change.
    - **2026-07-07 batch 2 (A-22 write-path coverage).** Extracted the fovea
      voltage-binding selection out of the `createRecording` closure into an
      exported pure `resolveFoveaBinding(deps, conv, mirror)` (internal refactor,
      identical behavior) so the fin/live branch is unit-testable. NEW tests (3):
      binds the FIN outcome when `deps.foveaBinding` matches (source "fin",
      frame_id), falls back to live snapshot when it returns null AND when the
      hook is absent. Gates: vue-tsc 0; vite build OK; renderer zero-core 0;
      orch zero-Vue 0; recording-metadata 5/5 (isolated). **Note:** full vitest
      shows 3 failures in `test/workload-view.test.ts` — those are C-18's
      concurrent metering/profiler work on the shared tree (C-owned, excluded
      from my scope), NOT this batch; all 253 non-workload-view tests pass.
    - **2026-07-07 batch 3 (A-P1 building-block coverage).** `session-resources.ts`
      (DisposerBag/releaseLeases/bindViews — the primitives the future breaking
      A-P1 sits on) had NO direct tests. NEW `test/session-resources.test.ts`
      (8): DisposerBag order/idempotent-dispose/push; releaseLeases null-safe +
      LeaseSet + CalibratedTriple.leases; bindViews default-frame-publish +
      custom onView + unsubscribers-added-to-bag. Gates: vue-tsc 0; vitest
      268/268 (+8; C-18's workload-view failures from batch 2 are resolved —
      C committed). test-only. (Priority-2 lease adoption surveyed: the 7 triple
      sessions are all already on the primitives; the remaining single-lease/Map
      sessions — calibrate-intrinsic/manage-cameras/single-capture — don't fit
      the triple primitives, so no further adoption without inventing a one-off
      = churn, skipped.)
    - **2026-07-07 batch 4 (A-P1 core machinery — GREEN-LIT).** NEW
      `app/orchestrator/resource-session.ts`: `defineResourceSession(name,
      contract, build)` + `ResourceScope` (`defer`/`add`/`push`/`use`/
      `cancelled`), built ON the A-R2-P1 session-resources primitives. Each
      activation gets a generation-tagged scope that OWNS its cleanups and
      drains them LIFO on idle; enforces the two lifecycle invariants the
      hand-rolled sessions kept re-breaking: (1) ordered async drain — `idle()`
      returns a promise `drained()` awaits (V1/RT1); (2) stale-async-completion
      safety — a slow `activate` superseded by idle/re-activate releases every
      resource it acquires instead of leaking, and a re-activation serializes
      behind the prior drain (V5/V10). Additive: sits ALONGSIDE `defineSession`,
      no session migrated yet (incremental next). NEW `test/resource-session.test.ts`
      (7): LIFO drain, use auto-release, superseded-slow-activate no-leak,
      re-activation-waits-for-drain, idle-hook-after-drain, throwing-activate
      caught, defer-after-supersession-runs-now. Gates: vue-tsc 0; vitest
      275/275 (+7); vite build OK; orch zero-Vue 0; renderer zero-core 0.
    - **2026-07-07 batch 5 (A-P1 reference migration — calibrate-drift).**
      Migrated `modules/calibrate-drift/session.ts` from `defineSession` to
      `defineResourceSession`: `activate(scope,s)` registers each resource's
      cleanup on the scope (lease via `scope.use` → releases LAST; trackers/
      taps(DisposerBag)/servo/timer via `scope.defer`), `idle()` is just the
      `resetTelemetry` hook (scope drains automatically, LIFO). Teardown order
      preserved (servo→trackers→taps→leases-last); adds cancel-safety
      (superseded slow activate releases leases) + a real awaitable drain for
      the multi-window switch path. Behavior-preserving; **HARDWARE-FACING —
      code-verified only, needs a rig pass** (the machinery is unit-tested in
      batch 4; calibration sessions have no unit harness). Gates: vue-tsc 0;
      vitest 275/275; vite build OK; orch zero-Vue 0; renderer zero-core 0.
      Next: migrate the remaining triple sessions (distortion/multi-fovea/
      extrinsic/tracking/manual-control) one per batch. **Pending handoff
      (C-18, will slot in):** extend `stats.ts`/`contracts.ts` workload
      stream-counter `CounterRate` → `WorkloadStreamStat = CounterRate &
      {maxIntervalMs}` (mirror C's metering.ts type; additive).
    - **2026-07-07 batch 6 (C-18 handoff — workload stream-stat type).** Added
      `WorkloadStreamStat = CounterRate & { maxIntervalMs?: number }` to
      `stats.ts` and used it for `WorkloadSnapshot.inputs/outputs`; extended
      `contracts.ts` `WorkloadCounterSnapshot` with `maxIntervalMs?`. Profiler
      now reads `maxIntervalMs` TYPED (no `as any` cast). **Deviation from the
      handoff (flagged):** made it OPTIONAL not required — C's own
      `workload-view.test.ts` fixtures (C-owned, collision-excluded) omit
      `maxIntervalMs`, so a REQUIRED field would fail vue-tsc on a file I can't
      touch. Optional is non-breaking + still typed; C can tighten to required
      alongside updating those fixtures. metering.ts already sets it at runtime.
      Gates: vue-tsc 0; vitest 275/275; vite build OK; zero-Vue/zero-core.
    - **2026-07-07 batch 7 (A-P1 migration — calibrate-distortion).** Same
      pattern as drift: `defineResourceSession`, leases via `scope.use`
      (release-last), trackers/taps/actuation-loop via `scope.defer` (LIFO
      drain), idle hook resets centerAngle/projection + telemetry. Teardown
      order preserved; cancel-safe + awaitable drain. Behavior-preserving,
      **hardware-facing — code-verified only.** Gates: vue-tsc 0; vitest
      275/275; vite build OK; zero-Vue/zero-core. Triple sessions migrated:
      drift, distortion (2/6). Remaining: multi-fovea, calibrate-extrinsic,
      tracking-single, manual-control — next batches, one per.
    - **2026-07-07 batch 8 (A-P1 migration — multi-fovea).** `scheduler`/
      `runtime` stay session-level singletons; per activation the lease (via
      `scope.use`, release-last) + the C.onView tap are scoped, and the drain
      stops the scheduler + disposes the runtime (re-populated by `applyTargets`
      on the next activate, as before). Tap registered LAST → drains FIRST so no
      center frame reaches a disposed runtime mid-teardown (tightens a latent
      order the hand-rolled idle had). Behavior-preserving; **hardware-facing —
      code-verified only.** Gates: vue-tsc 0; vitest 277/277; vite build OK;
      zero-Vue/zero-core. Triple sessions: drift, distortion, multi-fovea (3/6).
    - **2026-07-07 batch 9 (A-P1 migration — calibrate-extrinsic, the wizard).**
      Two-stage acquire (matchTriple → center-intrinsic load) still releases
      IMMEDIATELY on either failure (+ `scope.cancelled` guards); the lease
      becomes scope-owned (deferred, release-last) only once both succeed.
      servo/preview toggle per wizard step via `enterStep` (imperative,
      unchanged); the scope's drain (registered LAST → drains FIRST) stops
      whichever is active. taps→local DisposerBag; idle hook resets fitted
      regressions + telemetry. Behavior-preserving; **hardware-facing —
      code-verified only.** Gates: vue-tsc 0; vitest 277/277; vite build OK;
      zero-Vue/zero-core. Triple sessions: +calibrate-extrinsic (4/6).
    - **2026-07-07 batch 10 (A-P1 migration — tracking-single, minimal/surgical
      per the KCF cut-over heads-up).** Thin swap of activate/idle: tracker/
      kinematic/frame-workers stay session-level singletons; per activation the
      lease (`scope.use`, release-last) + 3 stream taps (local DisposerBag) +
      actuation loop are scoped. Drain LIFO: loop.stop → disengage(false) →
      taps → worker-cancels → triple/size/lastFrameTime reset → leases. Did NOT
      restructure the tracker/worker plumbing (leaving it clean for the
      KcfTrackerStream swap). Behavior-preserving; **hardware-facing —
      code-verified only.** Gates: vue-tsc 0; vitest 277/277; vite build OK;
      zero-Vue/zero-core. Triple sessions: +tracking-single (5/6). **Remaining:
      manual-control only (the async-capture/recording-drain one) — paused here
      per planner request for the WAVE-4 checkpoint commit.**

- **A-24 — WS1 LIVE CUT-OVER (real-1c + 1d): flip the live preview + tracking onto
  the free-running threads. THE milestone integration. PLAN-FIRST (high blast
  radius — it breaks the live path; green-lit per the converge-at-milestone
  posture). Priority over A-P1 manual-control.**
  - **Phase 1 — staging plan (reply in your log / SendMessage-to-main-equivalent;
    NO execution).** Read B's + C's cut-over handoffs (their logs) + the current
    `registry.ts` producer loop, `StreamView`, the tracking session
    (`AsyncKcfTracker`), and `system.ts` perfSnapshot. Propose: the STAGING (I
    expect ~3 stages — SHM producer cut-over, KCF cut-over, probe splice), exactly
    what breaks at each stage, what's verifiable without hardware (synthetic pipe /
    unit tests) vs RIG-GATED, and the rollback story. Stop for my review.
  - **Phase 2 — execute (after my go):**
    1. **SHM producer:** in `registry.ts`, replace the JS per-frame SHM write
       (nextSlot/convert/publish/copyTo/release) with: on shared-camera acquire →
       advertise a `camera:<serial>` pipe (BGRA8 `PipeSpec`) via C's
       `pipeSession().advertise` + `Aravis.attachCameraPipe(lease.camera, pipeId)`;
       on release → `detachCameraPipe` + `unadvertise`. Renderer `StreamView`
       connects to the pipe via C's `pipe-consumer` (react to `state.pipes`)
       instead of `useSession().frame()`. Preserve the in-process vision view-taps
       (co-subscribers — unaffected).
    2. **KCF:** retire the JS `AsyncKcfTracker` → `const tk = Tracker.createTracker(
       centerLease.camera); tk.arm(roi); for await (const r of tk) publish(r.bbox);
       tk.release()` on teardown.
    3. **Instrumentation:** splice C's `Pipe.probeAll()` + `tk.probe()` into
       `perfSnapshot.workloads` (`system.ts` — the C-6 handoff site).
  - **Ownership.** `registry.ts`, `StreamView.vue`, the tracking session,
    `system.ts` — all A. Call C's `pipe-session`/`PipeHub` + B's `attachCameraPipe`/
    `createTracker` across their interfaces (don't modify them).
  - **DoD (Phase 2).** vue-tsc 0, `vitest run`, `vite build`, orchestrator
    zero-Vue, renderer zero-core, V11 if a preload is touched. The freeze-gone /
    ~60fps / `loopLag`<5ms / `maxInterval`-flat proof is the **USER's rig pass**
    (Stage F) — flag every rig-gated surface; do not claim live perf.
  - Log:
    - **PHASE 1 — STAGING PLAN (2026-07-07; no execution, for planner review).**
      Read B-16/B-17 (attachCameraPipe seam + `Tracker.createTracker`/1d KCF
      thread — both camera-free-verified) and C-19/C-20 (collapsed publisher →
      `Publisher::offer` seqlock-writes SHM on B's producer thread; dynamic pipe
      lifecycle: `pipeSession()` → `{advertise(spec)→epoch, unadvertise(id)}`,
      reactive `state.pipes: Record<id,PipeAdvert{spec,epoch}>`, `connectPipe→
      PipeHandle`, `createPipeConsumer(handle,io,sink)`, `Pipe.probeAll()`).
      Current A surfaces confirmed: registry JS loop does BOTH the SHM preview
      write (`shmWriter/nextSlot/frame.view→slot/publish`→`s.sinks`/onFrame) AND
      the in-process BGRA view-taps (`s.viewSinks`/onView, copied from the slot);
      raw-preview `onFrame` consumers = manage-cameras, calibrate-intrinsic,
      single-capture (+welcome); processed vision frames ride `onView`→
      `s.frame()` (untouched). tracking session = `AsyncKcfTracker` in the center
      frame-worker. `system.ts` splices `workloads: workloadsSnapshot()`.

      **STAGE 1 — SHM producer cut-over (real-1c), two coordinated halves.**
      *1a orchestrator (registry.ts + orchestrator index):* on shared-camera
      acquire → `advertise({id:"camera:<serial>", BGRA8 geom})` +
      `Aravis.attachCameraPipe(lease.camera, pipeId)`; on last release →
      `detachCameraPipe` + `unadvertise`; DELETE the JS SHM write (shmWriter/
      nextSlot/view→slot/publish + the `s.sinks`/`emit("shm")` path); KEEP the JS
      loop for view-taps but convert `frame.view("BGRA8", tapView)` DIRECTLY (no
      slot) and start it only when `viewSinks` non-empty; live-wire `pipeSession`
      into the orchestrator hub. *1b renderer (StreamView + the raw-preview
      modules):* swap `session.frame(serial)` for a pipe consumer — discover
      `camera:<serial>` from reactive `state.pipes`, `connectPipe`,
      `createPipeConsumer(handle, io=preload readPipe, sink→FramePayload ref)`,
      feed StreamView; reconnect on epoch bump, clear on CLOSED.
      **Breaks:** raw camera preview ONLY, and only in the window between 1a and
      1b — land them together (or a one-flag guard). Processed vision frames,
      recorder (consumes `camera.stream` directly), and calibration overlays are
      UNAFFECTED. **Verifiable no-HW:** advertise/attach/detach orchestration
      (fake broker + fake `attachCameraPipe`) → acquire=advertise+attach,
      release=detach+unadvertise, epoch; renderer bind (fake `PipeReaderIO` +
      C's deterministic `poll()`); B/C loopback tests already green
      (11-capture-pipe fake-cam attach→BGRA readback, pipe-consumer resize).
      **RIG-GATED:** freeze-gone/~60fps/loopLag<5ms/maxInterval-flat = user
      Stage-F. **Rollback:** the JS write + onFrame path is a self-contained
      block; revert = restore it + repoint StreamView to `session.frame()`
      (uncommitted → `git restore` registry.ts + the raw-preview modules).

      **STAGE 2 — KCF cut-over (1d), tracking session only.** Replace
      `AsyncKcfTracker` with `const tk = Tracker.createTracker(centerLease.camera)`;
      `tk.arm(roi)` on startTracker/steer; a scope-registered `for await (const r
      of tk) publish(r.bbox/target)` loop; `tk.release()` on teardown (scope.defer
      — ties into the A-P1 scope I just landed on this session). The center
      frame-worker keeps undistort/slice/publish for DISPLAY; only the JS
      `kcf.update` call is removed (KCF now on B's Sub::Latest native thread).
      **Breaks:** tracking-single's tracker only. **Verifiable no-HW:** A-side
      wiring with a fake Tracker stub (async-iterable + arm/release spies) →
      arm-on-select, publish-on-yield, release-on-idle, no-leak-on-reactivate
      (A-P1 scope); B's 12-kcf-tracker (fake-cam, drops-on-stall) already proves
      the thread. **RIG-GATED:** tracking accuracy/latency/60fps = user rig.
      **Rollback:** localized to tracking session.ts; `AsyncKcfTracker` retired
      only after proven — revert restores it.

      **STAGE 3 — probe splice (system.ts).** `workloads: { ...workloadsSnapshot(),
      ...Pipe.probeAll(), ...(tk-live ? { "tracking:kcf": tk.probe() } : {}) }` —
      both native probes already in the `WorkloadSnapshot` shape (C/B built them
      so; my optional `maxIntervalMs` from A-23 batch 6 accommodates them).
      **Breaks:** nothing (additive). **Verifiable no-HW:** unit-test the merge
      with fake probe outputs. **RIG-GATED:** the live maxInterval numbers.
      **Rollback:** remove the spread (one line).

      **Sequencing:** Stages 1 and 2 are independent; recommend 1 (flagship
      freeze fix) → 2 → 3 (or fold each probe into its stage). **OPEN QUESTIONS
      for review (before Phase 2):** (Q1) confirm the JS registry loop stays a
      co-subscriber for `onView` taps (direct `frame.view` convert), native
      CaptureSink owns the SHM write — or do view-taps also move? (Q2)
      `attachCameraPipe` timing — on acquire (advertise+attach together) vs first
      `connectPipe` (B's "subscribe lazily starts stream"); how it composes with
      C's connectPipe refcount + unadvertise. (Q3) want a reusable renderer
      `usePipeFrame(pipeId)` composable (state.pipes→connectPipe→consumer→ref) so
      raw-preview call sites swap uniformly, or per-module? (Q4) confirm the
      StreamView→pipe swap is raw-camera surfaces ONLY (processed L/C/R stay on
      `session.frame`). (Q5) milestone scope — static `camera:<serial>` + KCF
      only, or also cut multi-fovea onto dynamic `fovea:<...>` pipes now?
      Stopping for your review — no code changed.
    - **PHASE 2 — STAGE 1a LANDED (orchestrator SHM producer cut-over; 2026-07-07).**
      Split Stage 1 into two software-green sub-checkpoints (the 1a+1b "pair" is a
      RIG constraint — software gates don't render live frames — so 1a alone is
      green; **flagging: both must land before the user's rig pass or raw previews
      are dark**). *1a = orchestrator.* `registry.ts`: injected `RegistryPipeSeam`
      (`advertise/unadvertise/attach/detach` — set from the index; keeps registry
      native-free + testable); on shared-camera acquire → `advertiseCameraPipe`
      (BGRA8 `camera:<serial>` spec from GenICam `getFeature("Width"/"Height")`) +
      `attach`; on last release → `retireCameraPipe` (detach→unadvertise); DELETED
      the JS SHM write (shmWriter/nextSlot/slot-publish/`onFrame`/`s.sinks`/
      `emit("shm")`); the JS loop is now VIEW-TAP ONLY (`frame.view("BGRA8",
      tapView)` direct) and `hasConsumers`=viewSinks — a preview-only camera
      (manage-cameras) runs NO JS loop → fully off-loop (the freeze fix,
      rig-gated). `index.ts`: wired C's `pipeSession(asBroker(Pipe))` into the hub
      + `setRegistryPipeSeam` (Aravis pipe NAPIs cast — not in d.ts yet, B-owned).
      Dropped the raw-preview `onFrame` publishes in manage-cameras/
      calibrate-intrinsic/single-capture sessions (vision `onView` taps
      untouched). NEW `test/registry-pipe.test.ts` (2, fake seam+camera): advertise
      = correct BGRA8 geometry + attach-after-advertise; retire = detach→
      unadvertise. Gates: vue-tsc 0; vitest 279/279 (+2); vite build OK; orch
      zero-Vue 0; renderer zero-core 0. **RIG-GATED (user Stage-F):** freeze-gone/
      fps/loopLag — no live claim. Retired JS SHM write is in the prior commit
      (rollback = git restore). **NEXT: Stage 1b** (renderer `usePipeFrame`
      composable + repoint manage-cameras/calibrate-intrinsic/single-capture/
      welcome StreamViews from `session.frame` to `camera:<serial>` pipes) — the
      other half of the pair; then Stage 2 (KCF), 3 (probe).
    - **PHASE 2 — STAGE 1b LANDED (renderer pipe binding; 2026-07-07). STAGE 1
      COMPLETE (1a+1b pair).** NEW `usePipeFrame(pipeId)` in `client.ts`
      (A-owned): `useSession(pipes, "pipes")` → watches a primitive `id#epoch`
      key off reactive `state.pipes` → `connectPipe` → C's `createPipeConsumer(
      handle, pipeReaderIO, sink→ref)` (pixels ride the shared segment via the
      shm client's `readPipe`/`releaseBuffer` C-15 pool) → reconnects on epoch
      bump (C-20 reuse-safe id), tears down (stop + `disconnectPipe` + clear) on
      un-advertise / switch / scope-dispose; supports static or ref/getter
      pipeId. Repointed the 4 raw-preview surfaces from `session.frame()`:
      manage-cameras `CameraConfig.vue` (`camera:${serial}`), calibrate-intrinsic
      (`camera:${activeSerial}`), single-capture (`camera:${serial}`),
      WelcomeWindow (dynamic). Processed L/C/R stay on `session.frame` (Q4).
      Gates: vue-tsc 0; vitest 279/279; vite build OK; renderer zero-core 0; orch
      zero-Vue 0; V11 preload-renderer 0/0 (preload untouched). **Verification:**
      the composable is thin wiring over ALREADY-tested primitives —
      `createPipeConsumer` (C's `pipe-consumer.test`, fake `PipeReaderIO`+`poll`),
      `useSession`/`state.pipes`/`connectPipe` (C's `pipe-session.test`); no
      dedicated composable test since `usePipeFrame` calls `useSession`
      same-module (unmockable), and vue-tsc pins the wiring types. **RIG-GATED
      (user Stage-F):** actual live rendering off the pipes (real cameras + B's
      native producer) — no live claim. **Minor UX flag:** raw-preview
      StreamViews now pass no `:source`, so their expand button falls back to
      element-fullscreen (not a projection window) — pipe-based projection is a
      later add if wanted. **Stage 1 ready for your verify + commit (1a+1b as the
      pair); then Stage 2 (KCF), 3 (probe).**

## Coder B — Native core, protocol & firmware

Owns `core` native code (except the SHM substrate), `firmware/**`, and
the protocol-v2 host+MCU surface — the synced-capture lineage: bench
readiness, P3.1a/P4/P5 when hardware returns, FIN-trace diagnostics,
tracker/controller/dispatcher native work. The former "finisher" role is
retired: each coder fixes planner findings in their own area; quality
control is the planner's review loop.

### Active instructions

- **(B-11 wave-3 accepted & archived 2026-07-07 → proposals/TRIAGE.md.)**

- **(B-12 refactor wave-1 accepted & archived 2026-07-07 → refactor-plan.md.)**

- **(B-13 refactor wave-2 accepted & archived 2026-07-07 → refactor-plan.md.)**

- **(B-14 WS4-4b decoder accepted & archived 2026-07-07 → refactor-plan.md.)**

- **(B-15 non-breaking loop — 4 batches accepted & archived 2026-07-07 → refactor-plan.md.)**

- **B-16 — WS1 real-1c B-side: Aravis capture → C's producer sink (the C↔B seam;
  milestone). DESIGN-FIRST — the cross-role crux.** C-19 moves the SHM producer
  into a free-running C++ thread; the frames come from your Aravis surface.
  - **Phase 1 — design sketch (reply via SendMessage; no build yet; converges with
    C's producer-sink interface, which I'll relay).** Survey your Aravis
    `Camera`/`Stream`/`Frame` native code and propose:
    1. **Thread-boundary recommendation.** WHO owns the capture thread?
       **My lean (rule unless you make a strong Aravis-safety case otherwise): B
       owns a capture thread** that `arv_stream_timeout_pop_buffer`s, converts via
       `Frame::view`/cvtColor into a REUSABLE BGRA buffer (persistent, no per-frame
       alloc/thread-spawn), **releases the Aravis buffer** (honoring the extract-
       before-release hazard — [[feedback_frame_release]]), then `offer()`s the
       BGRA buffer to C's producer sink (latest-wins single slot). This keeps ALL
       Aravis buffer lifecycle inside B and hands C ready bytes → C's publisher
       stays raw-memcpy convert-agnostic. The alternative (C's thread calls B pop+
       convert APIs) drags Aravis lifecycle into C-owned code — argue for it only
       if there's a real reason.
    2. **The exact frame the sink receives** (BGRA8 buffer ptr + w/h + stride +
       FrameMeta) — must match C's `offer(...)` signature (C posts it; I relay so
       you converge, don't guess).
    3. Where this hooks per shared camera (start/stop with the pipe lifecycle), and
       how the existing in-process view-tap consumers (vision) still get frames.
  - **Phase 2 — build (after I reconcile your sketch with C's interface).** The
    capture thread + convert + release + offer, metered via C's `ThreadMeter`
    (C grants/owns it; you instantiate one for the `camera` capture stream). No
    `registry.ts` (A's cut-over). Aravis per-process exclusivity is satisfied (the
    thread is in-process).
  - **Ownership.** Your Aravis `Camera`/`Stream`/`Frame` (`core/**` B-side). C owns
    `Pipe`/`ThreadMeter` (call across the interface). `registry.ts` is A.
  - **DoD (Phase 2).** `core make build` both runtimes; a no-hardware test if the
    capture path can be driven by a fake/loopback Aravis source (else compile-
    verified + a clear note that live capture is rig-gated); frame-release hazard
    respected (convert before release). The rig pass is the user's milestone check.
  - Log: **Phase 1 (design, accepted) + Phase 2 (build) DONE — compile + no-
    hardware-loopback verified; live capture rig-gated (Stage F).**
    **Seam (as reconciled with C's `Pipe.h`):** B already owns the per-camera
    capture thread — the base `Stream<Frame::Ptr>` thread (`iterate()` pops the
    ArvBuffer, `Frame::create` COPIES it out, `push_buffer` releases it, then
    fans `Frame::Ptr` to subscribers). NEW B-owned `Arv::CaptureSink`
    (`core/lib/Aravis/CaptureSink.{h,cpp}`) is one more `Subscriber` on that
    thread: converts `frame->raw`→BGRA8 into a REUSABLE `cv::Mat` (no per-frame
    alloc) via `cvtColorCode(fmt,BGRA8)` and `offer()`s to C's
    `FrameSink` (`PipeHub::sink(id)`). Vision view-taps = co-subscribers,
    untouched. **Frame-release hazard structural:** raw is a heap copy + the
    ArvBuffer is back in Aravis's pool before any subscriber runs — feedPipe
    never touches Aravis memory.
    **Contract filled:** `FrameInfo{width,height,channels=4,stride=dst.step,
    bytes=w*h*4 (tight = bytesPerFrame)}`; `ShmRing::FrameMeta{tCapture(now),
    convertMs(measured),deviceTimestamp,systemTimestamp}` from `Frame`. Size
    guard: a frame whose W×H≠pipe geometry is DROPPED (not offered) — A
    re-advertises. **Metering:** no separate `ThreadMeter` — post-collapse C's
    `Publisher::offer()` records its own meter (incl. the `convertMs` I pass) on
    my producer thread, per C's `Pipe.h`. **Construction pattern:** subscribe-in-
    ctor + `Shared<CaptureSink>::create` (mirrors `Sub::Latest`/`Queue`); dtor
    `close()`s before `stream_` releases.
    **No-hardware test:** added a B test hook `Aravis.feedTestFrame(pipeId,
    srcFormat,fill)` (forward-declared in `Addon.cpp` to dodge the Aravis global
    `Object` vs `Napi::Object` clash) + `core/test/11-capture-pipe.ts`: advertise
    BGRA8 pipe → connect → feed synthetic Mono8 → reader reads back BGRA8
    (GRAY→BGRA: B=G=R=fill, A=255) + meta.deviceTimestamp. Runs green.
    **HANDOFF TO A (cut-over, 1c):** A's registry constructs a
    `Arv::CaptureSink::create(Stream::get(camera), PipeHub::sink(pipeId),
    w, h)` on pipe-connect and drops the `Ptr` on disconnect (subscribe lazily
    starts / unsubscribe pauses the Stream thread). A needs a JS→C++ construct
    seam (a NAPI attach, analogous to C's `attachSynthetic`) — I can add
    `Aravis.attachCameraPipe(serial,pipeId)`/`detach` when you green-light (kept
    out of this build since it's A's cut-over wiring).
    **Gates:** `core make build` both runtimes ✓; `core/test/11-capture-pipe.ts`
    green (no-hardware loopback); `09-pipe.ts` green (C's path unregressed after
    the `Addon.cpp` edit); reader addon `otool -L` system-libs-only (0 opencv/
    aravis/glib — I didn't touch it). NOT hardware-verified (Stage F milestone
    is the user's rig check). Did NOT touch `registry.ts`, C's `Pipe`/
    `ThreadMeter`/reader.

- **B-17 — (1) the `attachCameraPipe` cut-over glue [build now], then (2) 1d KCF
  tracker thread [design-first].**
  - **Part 1 — `attachCameraPipe` NAPI seam (build now; unblocks A's cut-over).**
    The JS→C++ construct seam your B-16 handoff named: a NAPI that, on pipe
    connect, does `Arv::CaptureSink::create(Stream::get(camera), PipeHub::sink(
    pipeId), w, h)` and returns a handle A drops on disconnect (analogous to C's
    `attachSynthetic`). A calls it from the cut-over. **`core/addon.cpp` is a
    shared NAPI-registration hub — APPEND your registration; do NOT modify C's
    pipe registrations (C-20 is editing addon.cpp concurrently).** DoD: `core make
    build` both runtimes; extend `11-capture-pipe.ts` (or a small test) to drive
    attach→frames→detach camera-free; reader `otool -L` clean.
  - **Part 2 — 1d: KCF tracker → its own free-running C++ thread (DESIGN-FIRST,
    reply via SendMessage, no build).** The milestone's second thread
    ([[project_async_kcf_cpp_thread]]): the center-camera KCF moves OFF the JS
    event loop into a dedicated C++ thread consuming the LATEST camera frame,
    results back via async generator; instrumented by C's standalone `ThreadMeter`
    (granted, probed out-of-loop — reuse it, don't fork). Sketch: how the KCF
    thread gets the latest frame (another `Subscriber` on the existing Aravis
    stream keeping latest-wins, like `CaptureSink`? or off the pipe?), how results
    return to the orchestrator (async generator seam), the `ThreadMeter`
    integration, and what A must wire (the tracking session's KCF call site).
    Stop at the sketch for my review.
  - **Ownership.** Your Aravis/`Tracker` (`core/**` B) + `addon.cpp` (shared-
    append). Call C's `PipeHub`/`ThreadMeter` across the interface, don't modify.
    `registry.ts`/tracking session are A.
  - Log:
    - **Part 1 (attachCameraPipe seam) — LANDED, camera-free end-to-end
      verified.** `core/lib/Aravis/CaptureSink.cpp`: `attachCameraPipe(camera,
      pipeId)` unwraps A's SHARED lease (`convert<Arv::Camera::Ptr>`) →
      `Stream::get(camera)` (idempotent — reuses the one stream preview/vision
      already share; Aravis per-process exclusivity honored) → `PipeHub::sink(
      pipeId)` + `spec()` geometry → `CaptureSink::create(...)`, stored in a
      B-owned `map<pipeId, CaptureSink::Ptr>` (1:1). `detachCameraPipe(pipeId)`
      drops the Ptr OUTSIDE the lock (unsubscribe may block) → returns whether
      one existed (idempotent). Registered by APPENDING to `core/addon.cpp`
      (forward-declared; did NOT touch C-20's pipe registrations). **Test:** the
      seam is now driven END-TO-END camera-free via Aravis's built-in fake
      camera — added `Aravis.enableFakeCamera()` (`arv_enable_interface("Fake")`);
      `core/test/11-capture-pipe.ts` now: enableFakeCamera → list → advertise a
      BGRA8 pipe at the fake cam's 512×512 → connect → `attachCameraPipe` → reads
      real Mono8→BGRA8-converted frames off the live Arv::Stream (asserts B==G==R,
      A==255 per pixel) → `detachCameraPipe` (idempotent). **Gates:** `core make
      build` both runtimes ✓; `11-capture-pipe.ts` green (loopback + fake-camera
      attach/detach); `09-pipe.ts` green (C's path unregressed after the addon
      append); reader `otool -L` 0 non-system deps. **A cut-over:** call
      `Aravis.attachCameraPipe(lease.camera, pipeId)` on pipe-connect,
      `detachCameraPipe(pipeId)` on disconnect.
    - **Part 2 (1d KCF thread) — LANDED (design approved; v1 full-frame),
      camera-free verified.** The milestone's SECOND thread. NEW
      `KcfTrackerStream : TransformStream<Arv::Frame::Ptr, TrackResult::Ptr>`
      (core/src/Tracker.cpp): its base `Stream<TrackResult::Ptr>` thread pulls
      the LATEST center-camera frame via the built-in `Sub::Latest` (latest-wins,
      drop-stale — a co-subscriber on the shared Arv::Stream, NOT off the BGRA
      pipe) and runs FULL-FRAME `cv::TrackerKCF::update` OFF the JS loop.
      `transform` = meter ingest + (drop delta) + begin/update/end + emit; `arm(
      roi)` (re-)inits KCF on the next frame (lazy, JS-callable). Results stream
      to JS via the standard async-generator seam — `KcfTrackerObject`
      (CoreObject) exposes `[Symbol.asyncIterator]` (a `Sub::Queue` on the
      stream, exactly like `StreamObject`), `arm`, `probe`, `stall`(test);
      `Tracker.createTracker(camera)` factory (registered via
      `exportTrackerNamespace` — **addon.cpp untouched by 1d**). Typed in
      `core/dist/Tracker/index.d.ts` (`Tracker`/`TrackResult`/`TrackerMeter`/
      `createTracker`). **Meter:** reuses C's `Meter::ThreadMeter` (single writer
      = transform thread; probed out-of-loop → same shape as the pipe producer,
      splices into `perfSnapshot.workloads`). **Drop counter (as flagged):**
      added `droppedCount()` to `Sub::Latest` (counts overwrites of unconsumed
      frames) + `TransformStream::upstreamDrops()`; `transform` meters the delta
      via `meter_.drop()` — the "KCF can't keep up" signal.
      **Test** `core/test/12-kcf-tracker.ts` (fake camera, camera-free): steady
      state → 5 streamed results, frames/tracks/busyMs/interval metered,
      drops=0; then `stall(120ms)` (> the ~45ms fake-cam interval) → the camera
      outruns KCF and **drops climb 0 → 12** (drop signal proven). **Gates:**
      `core make build` both runtimes ✓; `12-kcf-tracker` + `08/09/10/11` all
      PASS unsandboxed; reader `otool -L` 0 non-system deps. v1 tracking
      accuracy/cost is RIG-GATED (Stage-F milestone pass). **Follow-up:** port
      the JS search-window crop into `transform` (perf; v1 is full-frame).
      **HANDOFF TO A (tracking-single cut-over):** replace the JS
      `AsyncKcfTracker` with `const tk = Tracker.createTracker(centerLease.camera)`;
      `tk.arm(roi)` on target select/re-init; `for await (const r of tk)
      publish(r.bbox)`; `tk.release()` on teardown; splice `tk.probe()` into
      `system.perfSnapshot.workloads` at the 1 Hz throttle (same as the pipe
      producer). `registry.ts`/the tracking session stay A's.

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

- **(C-18 max-interval diagnostic accepted & archived 2026-07-07 → refactor-plan.md; A handoff: `maxIntervalMs` on the workload stream-stat type in stats.ts/contracts.ts — filed to A.)**

- **(C-17 pipe-consumer stack accepted & archived 2026-07-07 → refactor-plan.md.)**

- **C-19 — WS1 real-1c: the MILESTONE driver. Separate the SHM producer into its
  own C++ thread, FREE from the orchestrator JS event loop, WITH a native
  instrumentation meter the orchestrator probes out-of-loop. GREEN-LIT to break
  the live SHM preview path (posture: converge at the milestone).**
  - **Phase 1 — SEAM REVIEW (stop for my go; this is architecture + cross-role).**
    Reply via SendMessage with:
    1. **Camera→producer→publisher seam.** How a camera frame reaches the C++
       publisher thread so the per-frame memcpy+seqlock runs OFF the JS loop.
       Evaluate the options against the CURRENT Aravis/registry reality (frames
       arrive in the orchestrator process; `project-orchestrator-camera-
       exclusivity`): e.g. (a) camera acquisition into a C++ capture thread feeding
       the publisher; (b) the existing camera NAPI frame handed to the publisher
       via a lock-free single-slot handoff (JS still triggers the handoff but does
       NOT do the memcpy/seqlock). State which, and exactly what the JS loop still
       touches per frame (goal: nothing but a pointer handoff, ideally not even
       that).
    2. **Native thread meter = the instrumentation API** (`project-thread-
       instrumentation-api`, milestone deliverable). How the C++ publisher thread
       records the C-18 metric block (maxIntervalMs 10×1 s bins + rate/util/drops)
       lock-free, and how the orchestrator PROBES it out-of-loop (reads the block,
       never per-frame) to fold into `perfSnapshot.workloads` — SAME schema C-18
       defined (`WorkloadStreamStat`/`INTERVAL_WINDOW`), so the profiler renders a
       native producer stream identically to a JS one.
    3. **Cross-role A-side (flag, don't do):** removing the live JS SHM write from
       `registry.ts` (A-owned), handing frames to your producer, live-wiring
       `pipe-session` into the orchestrator index, StreamView→pipe binding. List
       exactly what A must do; I sequence it with A (A is mid-A-P1) — you build the
       C-side against a test driver first.
  - **Phase 2 — BUILD (after my go).** Implement the C-side per the approved seam:
    the producer/publisher-thread SHM write + the native meter, proven by a native
    test (a driving thread feeds frames → publisher writes SHM off that thread →
    a consumer reads them; the native meter records intervals and a probe reads
    the metric block; inject a stall → the probed `maxIntervalMs` spikes). The live
    registry cut-over is the coordinated A-side follow-up — DON'T touch
    `registry.ts` yourself.
  - **Ownership.** `core/**` pipe substrate (C grant), `pipe-session.ts`,
    `pipe-consumer.ts`. `registry.ts` is A — handoff only. Native meter: new
    C-owned core file (grant it like Pipe.h/.cpp — note it in your seam sketch).
  - **DoD (Phase 2).** `core make build` both runtimes; reader `otool -L` clean;
    the new native producer-thread + meter test PASS unsandboxed; `09-pipe` still
    PASS; JS gates for any orchestrator-JS you own. The rig pass (freeze gone /
    ~60 fps / loopLag<5 ms / producer `maxInterval` flat) is the USER's milestone
    verification — you prove the mechanism, not the perf number.
  - Log: **Phase 2 DONE (C-side, against the test driver).** Mechanism proven;
    live registry cut-over is A's follow-up.
    - **Reconciled with B's finding → COLLAPSED the publisher thread.** B's
      per-camera Aravis capture thread (single-consumer pop) already runs off
      the JS loop, so a separate publisher thread is redundant: `Publisher::
      offer()` now seqlock-writes the frame DIRECTLY into the next ring slot ON
      the producer's thread (row-by-row, honoring stride), one copy, no extra
      thread, no ping-pong. Removed the C-16 thread/cv/pending handoff.
    - **Locked producer-sink interface (sent to B, ratify):** `FrameSink::
      offer(const void* data, const FrameInfo& info, const ShmRing::FrameMeta&
      meta)`; `FrameInfo{width,height,channels,stride,bytes}`; `Publisher`
      implements it; a C++ producer gets its sink via `PipeHub::instance().
      sink(id)`. offer() copies synchronously (B reuses 1 BGRA buffer); arbitrary
      stride accepted; size mismatch → drop + pipe re-advertise; FrameMeta v2 =
      {tCapture,convertMs,device/systemTimestamp} (captureSeq = a v3 follow-up).
    - **Native meter — NEW C-owned `core/include/ThreadMeter.h` +
      `core/src/ThreadMeter.cpp` (granted).** Standalone (1d KCF reuses it).
      SINGLE-WRITER (the producer thread, via offer) + SEQLOCK read: even/odd
      `version` + retry-on-torn (same as the SHM ring); the probe copies the POD
      block and computes on the copy at `now` (rotate-on-copy → correct aging +
      live in-progress stall). C-18 bin-ring (10×1 s) ported to C++, `ingest/
      emit/addBusy/drop`. `Publisher` owns one (`pipe:<id>`, in `frame`, out
      `shm`); records ingest+convert-busy at offer, emit on write.
    - **Probe out-of-loop:** NAPI `Pipe.probe(id)` seqlock-reads the block →
      a JS object in the EXACT `WorkloadSnapshot` shape (`window`, utilization,
      busyMs, inputs/outputs:{[s]:{count,ratePerSec,maxIntervalMs}}, drops) →
      the orchestrator folds it into `perfSnapshot.workloads` and the profiler
      renders a native producer stream identically to a JS one. `Pipe.
      injectStall(id,ms)` test hook. Added to the `core/Pipe` d.ts + glue.
    - **Native test** NEW `core/test/10-pipe-thread-meter.ts`: SyntheticProducer
      thread feeds → publisher seqlock-writes SHM off that thread → reader-addon
      consumer reads 10 frames (correct bytes/seq) → probe steady
      `maxIntervalMs`<100 ms → `injectStall(200)` → probed `maxIntervalMs`≥150 ms
      (and > steady). **PASS unsandboxed.**
    - **Gates:** `core make build` both runtimes CLEAN; reader `otool -L`
      (electron+node) = self+libc++.1+libSystem.B ONLY; `10-pipe-thread-meter`,
      `09-pipe` (collapse regression-free), `08-shm-ring` (live path) all PASS
      unsandboxed; vue-tsc **0**; vitest **275/275** (no orchestrator-JS changed
      in C-19; incl. A/B parallel landings). Not committed. NO perf claim (rig =
      user's 1e).
    - **Cross-role (flag, sequenced by you):** A — delete registry.ts JS SHM
      write, start/stop B's capture producer per shared camera + advertise
      `camera:<serial>` pipes, live-wire `pipe-session` into the orchestrator
      index, StreamView→pipe binding, splice `Pipe.probe()` into
      `perfSnapshot.workloads`. B — the Aravis `Camera` capture-subscriber that
      converts BGRA and `offer()`s to `PipeHub::instance().sink(pipeId)`
      (interface above, locked). `registry.ts` untouched by me.

- **C-20 — WS1 pipe protocol: DYNAMIC LIFECYCLE (user 2026-07-07). Design the
  protocol for fovea streams created/destroyed/resized on the fly, before the
  cut-over bakes in a static-set assumption. DESIGN-FIRST (contract-affecting).**
  - **Context.** `refactor-plan.md` §"WS1 pipe protocol — DYNAMIC LIFECYCLE".
    Multi-fovea tracking churns pipes continuously (create/destroy on interaction
    + scene change; each fovea resizes as it tracks). Your C-16/17/19 protocol
    advertises + symmetric-closes but has no live DISCOVERY channel and a
    recreate-per-resize size policy — both need rework for churn.
  - **Phase 1 — seam sketch (reply via SendMessage; no build).** Audit the current
    protocol against churn and propose:
    1. **Consumer discovery** — a subscribable advertise/un-advertise stream so the
       renderer learns of pipes appearing/disappearing at runtime (not a one-time
       `pipes` read). Where it lives (pipe-contract/pipe-session), the event shape,
       and how a late-joining consumer gets the current set + deltas.
    2. **Cheap, leak-free churn** — create/destroy many pipes fast; prove no leaked
       shm segments (shm_unlink on drop) / threads (collapse already = no
       thread-per-pipe); any pooling/bounding.
    3. **Resize policy** — replace recreate-per-resize: ring sized to a MAX fovea
       footprint (spec carries `maxBytes`/max w×h) with a varying active w/h inside
       it, or in-place resize up to a cap. Consumers must read the current active
       w/h per frame (frame meta or header field), not assume the spec's nominal.
    4. **Reuse-safe identity** — `fovea:<session>:<id>` with a generation/epoch so a
       consumer on a stale id observes CLOSED and never silently binds a reused id.
    5. Note what the A-side cut-over must do to USE this (advertise/notify wiring)
       and whether it changes the pinned `viewer-contract.ts` (planner-arbitrated).
  - **Phase 2 — build (after my go).** The protocol additions + tests: a churn test
    (create/destroy N pipes rapidly → no leaked segments, discovery events fire),
    a resize test (active w/h varies within a max-sized ring, no segment
    recreation, consumer reads correct bytes), reuse-safe id test (stale consumer
    sees CLOSED). Keep `camera:<serial>` (static, milestone) working unchanged.
  - **Ownership.** C's pipe substrate + `pipe-contract.ts` + `pipe-session.ts` +
    `pipe-consumer.ts` + `Pipe.h/.cpp`. `viewer-contract.ts` change → planner
    handoff. `registry.ts` is A.
  - **DoD (Phase 2).** `core make build` both runtimes; reader `otool -L` clean;
    new churn/resize/identity tests + `09-pipe`/`10-pipe-thread-meter`/`08-shm-ring`
    PASS unsandboxed; JS gates for the contract/consumer changes.
  - Log: **Phase 2 DONE.** Dynamic pipe lifecycle built; `camera:<serial>` +
    09/10/08 unchanged.
    - **Discovery:** `pipe-contract.state.pipes` → keyed
      `Record<pipeId, PipeAdvert{spec, epoch}>` (seeded to every subscriber =
      current set; snapshot-replaced on each advertise/un-advertise = delta —
      the viewer-`files` machinery, N bounded). `pipeSession()` now returns
      `{session, advertise(spec)→epoch, unadvertise(id)}`; A drives churn via
      those, the renderer reacts by diffing the reactive Record.
    - **Leak-free churn:** collapse already = no thread-per-pipe; `Segment` dtor
      `shm_unlink`s. Churn test (20 create/destroy) asserts every dropped
      segment is unlinked (`reader.open` throws). **Pool deferred** (profile-
      gated; all fovea rings share the max footprint → trivially poolable later).
    - **Resize (layout v3):** `SlotHeader` gains per-frame active `width/height`
      (LAYOUT_VERSION 2→3). `PipeSpec` gains `maxWidth/maxHeight/maxBytes` — a
      TUNABLE per-FOVEA cap (small hi-res crop, NOT camera res → N max rings
      stay bounded); the ring is sized to `maxBytes`, `offer()` validates active
      ≤ max, tight-packs the active frame + `publish`es active w/h; the read
      path (`ReadResult`→reader→`PipeReadFrame`→`pipe-consumer`) carries active
      w/h and builds `[h,w]` from it. Resize test: 4×4 then 12×10 in a 16×16
      ring, SAME segment, consumer reads correct bytes.
    - **Reuse-safe identity:** `PipeHub` keeps a per-id `epoch` (= segment
      generation) that PERSISTS across `drop` and bumps on each (re-)advertise →
      a new segment name; `drop` sets CLOSED then unlinks the old. Reuse test: a
      stale consumer on the old segment reads CLOSED, a re-advertise mints
      epoch 2 with a different `shmName`, and the stale consumer never binds the
      new. `PipeHandle.epoch` exposed; `advertise()` returns the epoch.
    - **Probe churn-consistent:** NEW `Pipe.probeAll()` → `{[id]:
      WorkloadSnapshot}` for the LIVE set only (a dropped pipe's meter is
      destroyed → absent; no stale workload rows). `Pipe.offerFrame(id,w,h,byte)`
      test hook. `core/Pipe` d.ts + glue updated.
    - **`viewer-contract.ts` UNTOUCHED** (pipes are the separate C-owned
      `pipe-contract`). Camera pipes byte-identical (max defaults to nominal;
      live `Shm.Writer` passes fixed dims via `publish`'s defaulted args).
    - **Gates:** `core make build` both runtimes CLEAN; reader `otool -L`
      self+libc++.1+libSystem.B ONLY; `08-shm-ring`/`09-pipe`/
      `10-pipe-thread-meter` + NEW `11-pipe-lifecycle` (churn/resize/reuse) PASS
      unsandboxed; vue-tsc **0**; vitest **277/277** (pipe-session +1 churn,
      pipe-consumer +1 resize); `vite build` GREEN, renderer 0-core /
      orchestrator 0-Vue, V11 `preload-renderer.cjs` 0/0. Not committed.
    - **A-side cut-over adds:** call `advertise`/`unadvertise` as foveas
      create/destroy, feed active-sized frames on resize, react to `state.pipes`
      in the renderer (bind/unbind + reconnect on epoch bump), and splice
      `Pipe.probeAll()` into `perfSnapshot.workloads`.

- **C-standby note.** C-1/C-2 were planner-accepted 2026-07-06 and
  archived (orchestrator.md §6 + §7.1 Stage 4).
- **(C-4 accepted & cleared 2026-07-06.)**
- **(C-13 wave-3 accepted & archived 2026-07-07 → proposals/TRIAGE.md.)**

- **(C-14 wave-4 accepted & archived 2026-07-07 → proposals/TRIAGE.md.)**

- **(C-15 refactor wave-1 accepted & archived 2026-07-07 → refactor-plan.md.)**

- **(C-16 refactor wave-2 accepted & archived 2026-07-07 → refactor-plan.md.)**

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
