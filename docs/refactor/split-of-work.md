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
| `core/include/ShmRing.h`, `core/src/ShmRing.cpp`, reader addon target, `core/test/08-shm-ring.ts` | C |
| `lib/orchestrator/viewer-contract.ts` — THE pinned A↔C contract; planner arbitrates changes | shared (planner) |
| `app/orchestrator/viewer/**`, `sessions/viewer.ts` | C |
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

- **A-20 — refactor WAVE 1: title-bar full-screen fix + window-ownership
  foundation.** Plan: `refactor-plan.md` WS3/WS2. Two independent A-owned pieces.
  **(1) UI-1 title bar in full screen (`app/src/components/TitleBar.vue`).**
  Symptom + root cause in `hil-findings.md` UI-1: bar height = `(rect.height ??
  40) + (rect.top ?? 0)`; macOS full screen makes `getTitlebarAreaRect().height`
  = 0 and `0 ?? 40` stays 0 → bar collapses. Fix VSCode-style: keep the bar
  VISIBLE in full screen with a stable base height; reserve traffic-light space
  only when windowed. Windowed: `height = (rect.height || 40) + rect.top`,
  `leftInset = rect.left` (already correct). Full screen: fixed base height,
  `leftInset = 0`, full-width bar. Verify BOTH transitions (needs user UI check —
  note that in the log).
  **(2) WS2 2a window-ownership foundation** (`app/electron/window-manager.ts`,
  `app/lib/windows.ts`). Per `project-multi-subwindow-per-app`: keep the flat
  `WINDOWS` table; add (a) an `owner?: ManagedWindow` parent-pointer on
  `ManagedWindow` + a `childrenOf(win)` walk in the manager; (b) an
  `onOwnerClose: "cascade" | "survive"` policy field on `WindowSpec` (existing
  classes: projection/viewer = `survive`, welcome/app/profiler = n/a or
  `survive`; the new debug class in 2b = `cascade`); wire `onWindowClosed` to
  cascade-close children whose class is `cascade`; (c) a keyed **toggle** helper
  modeled on `openViewer`'s `fileKey` dedupe (open-or-focus, plus a close path) —
  a reusable primitive for 2b's drawer toggle. NO new window class or debug
  window yet (that's 2b) — just the substrate + unit tests (window-manager suite).
  Standing gates (vue-tsc 0, vitest, vite build, bundle scans, V11). Never
  commit. Log ≤15 lines.
  - Log:

## Coder B — Native core, protocol & firmware

Owns `core` native code (except the SHM substrate), `firmware/**`, and
the protocol-v2 host+MCU surface — the synced-capture lineage: bench
readiness, P3.1a/P4/P5 when hardware returns, FIN-trace diagnostics,
tracker/controller/dispatcher native work. The former "finisher" role is
retired: each coder fixes planner findings in their own area; quality
control is the planner's review loop.

### Active instructions

- **(B-11 wave-3 accepted & archived 2026-07-07 → proposals/TRIAGE.md.)**

- **B-12 — refactor WAVE 1: FIN exposure-averaged MEMS voltage + frame-
  association key.** Plan: `refactor-plan.md` WS4 4a; spec
  `project-fin-exposure-voltage` + `docs/refactor/synced-capture.md`. Firmware +
  protocol, HARDWARE-GATED for live verify (Stage F) — this wave is
  compile-verified only.
  **(1) Exposure-averaged voltage.** In the firmware Capture engine
  (`firmware/include/Capture.h` / its .cpp — the CMD_FRAME/CMD_TRIGGER
  trigger/strobe state machine that emits FIN): sample the MEMS voltage(s) at
  exposure START and at exposure FINISH and report their **2-point average** in
  the FIN completion, replacing the current initial-voltage value. (Read the MEMS
  set/DAC state at both edges; average per mirror.) Preserve the existing FIN
  Teensy-timestamp fields.
  **(2) Frame-association key.** Extend the FIN payload so the reported voltages
  are tightly bound to THIS request's frame — carry the per-request `seq`
  (already present) PLUS whatever token the host needs to bind voltage→exact
  frame downstream (the recorder/UI will consume it in 4b). Add the protocol
  payload field(s) in `lib/Protocol` (host+MCU shared lib) — additive, keep
  `02-serial-protocol.ts` green. Document the new FIN payload shape in
  `synced-capture.md` (planner will ratify wording — propose it in your log).
  DoD: `pio run` SUCCESS (report FLASH size), `core make build` both runtimes,
  `02-serial-protocol.ts` green (host-side, no device). Live scope/rig
  verification is Stage F (do NOT claim hardware-verified). Never commit. Log
  ≤15 lines; note the FIN payload shape you chose for planner ratification.
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
- **(C-13 wave-3 accepted & archived 2026-07-07 → proposals/TRIAGE.md.)**

- **(C-14 wave-4 accepted & archived 2026-07-07 → proposals/TRIAGE.md.)**

- **C-15 — refactor WAVE 1: SHM consumer reuses pre-allocated buffers (kill the
  per-frame allocation).** Plan: `refactor-plan.md` WS1 1a; spec
  `project-shm-consumer-reuse-buffer` + `hil-findings.md` (manage-cameras freeze).
  Root cause: `app/lib/orchestrator/shm-client.ts` recycles via a shared pool
  capped at `MAX_POOLED_PER_SIZE = 3` per byte-size, but N same-resolution
  previews hold ~2N same-size buffers concurrently (1 transferred to the preload
  mid-read + 1 displayed), so `checkout()` allocates a fresh multi-MB
  `ArrayBuffer` every cycle → periodic major GC → the ~1–2 s preview freeze.
  Fix: make the consumer REUSE pre-allocated buffers so steady state never
  allocates. Honor the transfer constraint (the buffer is detached to the preload
  during a read) — so per stream needs ≥2 buffers (ping-pong). Either
  **per-consumer double-buffers** (each frame subscription owns 2 buffers sized to
  its frame, reallocating only on a resolution change) OR **auto-size the shared
  pool** to the live in-flight+displayed count (not a fixed 3). Preload side is
  already correct (`readShmFrame` → `reader.readInto(handle, dest)` reuses the
  passed buffer) — do NOT change it. Keep the `shmReads` allocations/poolHits
  telemetry so the fix is measurable (steady-state `allocations` → ~0 after warm
  up). This is the first WS1 step; the C++ publisher-thread architecture (1b/1c)
  is a LATER wave — do NOT start it here.
  DoD: standing gates + `08-shm-ring.ts` PASS (planner re-runs unsandboxed —
  note if your sandbox blocks `shm_open`), the buffer-ownership tests still pin
  success/null/timeout/stale, + a test proving no steady-state allocation for
  N≥3 same-size streams. Never commit. Log ≤15 lines.
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
