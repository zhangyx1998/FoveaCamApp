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

**Dispatch mechanics (updated 2026-07-06, workers switched to Claude
Sonnet 5):** workers are **Claude Sonnet 5 subagent sessions** spawned by
the planner through the harness Agent tool (`model: sonnet`), run in the
background — the planner is notified on completion and starts the
verification iteration. **Session persistence:** the planner continues a
role's existing agent via SendMessage (warm context) instead of
spawning fresh; a new spawn = a deliberate cold start at stage
boundaries. Workers inherit the planner's environment — that means the
repo working directory AND its quirks: use `node_modules/.bin/*`
binaries directly and `/opt/homebrew/bin/node` (v26.4.0) for
`core/test` scripts; the bare `node`/`npx` shell wrappers are broken in
this zsh. At most one session per role; roles may run concurrently
(ownership table keeps domains disjoint) but all log into this file —
if a concurrent write clobbers a log, the planner restores it from the
transcript. (Legacy: `scripts/dispatch-worker.sh` drove Codex sessions
until 2026-07-06 — retired after quota exhaustion; keep the script for
reference.)

**Standing gates (every instruction, unless it narrows them):**
`vue-tsc --noEmit -p tsconfig.json` → 0 errors; `vitest run` all green;
`vite build` fully green; renderer bundle **zero-core**; orchestrator
bundle **zero-Vue**; `core make build` both runtimes when native code is
touched; reader addon `otool -L` shows system libraries only; built
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
| `core/**` (everything else), `firmware/**`, protocol v2 host+MCU | B |
| `docs/refactor/*` (all files but this one), this file's non-Log text | planner |

## Coder A — App & sessions (renderer, orchestrator JS, Electron shell)

Owns all non-SHM application code: feature modules
(`contract/session/index.vue`), orchestrator runtime/sessions/store-hub,
shared app libs, Electron main/preload (non-SHM), Vue surfaces, app
tests. Boundary rules to preserve: hardware/vision/control stays
orchestrator-side; renderer stays a thin session client, zero-core;
orchestrator-reachable code stays Vue-free; never mark
hardware-dependent behavior verified without a real rig run.

### Active instructions

- **A-12 — tracking-single async tracker (PB3 residual).** Migrate
  tracking-single's synchronous KCF onto the `AsyncKcfTracker` pattern
  you built in A-4 (`disparity-scope/tracker.ts` — extract to a shared
  location if cleaner, e.g. `@orchestrator/async-kcf.ts`, updating
  disparity's import): busy-drop, generation staleness guard, results
  applied on completion. Preserve tracking-single's kinematic-predict
  timing semantics (predict runs in `targetVolts()` — unchanged).
  Harness: reuse/extend the async-tracker suite. DoD: standing gates.
  - Log:
- **A-13 — direct app-switch affordance (adopted default; user may
  veto).** Native application menu gains an "Apps" submenu listing the
  catalog (from `lib/windows.ts`); selecting one routes through the
  existing `openApp` drain/switch flow — zero new UI surface, the
  refusal prompt already exists. Welcome/profiler/projection windows
  get the same menu (it's the app-level menu). Small; test via
  window-manager harness if any logic is added, else log the manual
  check. DoD: standing gates.
  - Log:

## Coder B — Native core, protocol & firmware

Owns `core` native code (except the SHM substrate), `firmware/**`, and
the protocol-v2 host+MCU surface — the synced-capture lineage: bench
readiness, P3.1a/P4/P5 when hardware returns, FIN-trace diagnostics,
tracker/controller/dispatcher native work. The former "finisher" role is
retired: each coder fixes planner findings in their own area; quality
control is the planner's review loop.

### Active instructions

- **B-6 — Python sub-project `pyfovea` (Stage 5; spec:
  recorder-container.md §5 + the §2b schema contract).** Top-level
  `pyfovea/` (name is a planner placeholder — user may rename before
  PyPI): `pyproject.toml`, typed reader API over `.fovea` (use the
  `mcap` python package; decode `x-fovea-raw` from channel metadata —
  port `stream-decoder.py`'s 12p unpack + significant-bits scaling),
  PLUS the legacy `.stream`/`.meta` read path (absorb stream-decoder
  logic; old dumps stay loadable), streaming/re-index fallback for
  footerless files, CLI entry points (`inspect`, `export`, `convert`),
  tests against small fixtures (generate a tiny synthetic `.fovea`
  with the B-5 harness; check fixtures in). Environment: set up a
  local venv under `pyfovea/.venv` (gitignored) with
  `/opt/homebrew/bin/python3 -m venv`; pip grant limited to `mcap`,
  `numpy`, and test tooling — log exact versions; document the exact
  test command at the top of the package README (it becomes a standing
  gate). PyPI publishing is USER-GATED — prepare packaging only.
  DoD: package tests green via the documented command; app gates
  untouched.
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
- **C-standby.** C-7 (profiler UI on the metering schema)
  planner-accepted 2026-07-06 — archived to workload-metering.md.
  C-3/PB2 remains held (bench). Next C work: shm adoption items if the
  recorder viewer wants a playback ring, or projector-adjacent reads.
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
