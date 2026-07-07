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

- **A-17 — optimization survey ROUND 2 (docs-only; NO code).** Waves 1
  and 2 reshaped your surface (frame workers, `fovea-pipeline`,
  `useFrames`, `marker-calibration.ts`, the `WINDOWS` table, the typed
  bridge registry, `CAMERA_CONTROLS`, session `status`/`fail`). Re-survey
  your OWNED surface for what those changes exposed or left behind: (1)
  repetitive logic the new helpers DIDN'T absorb (e.g. session
  lease/drain/telemetry boilerplate not yet on a shared primitive;
  remaining `useSession` wiring duplication); (2) long/wordy names that
  survived; (3) better-fit solutions the new structure now makes cheap.
  Write ranked proposals (max ~12) to `docs/refactor/proposals/A-r2.md`,
  ids `A-R2-P<n>`, each with location(s), current→proposed sketch,
  **category: non-breaking | breaking**, rationale tied to a real cost,
  effort (S/M/L), risk. **Do NOT re-propose** the still-open approved
  breaking waves (A-P1 lifecycle unification, A-P7 camelCase, A-P12
  explicit frame address) or deferred A-P6 (post-smoke) — reference them
  if adjacent, don't duplicate. Note any cross-role seam. Log a 3-line
  pointer under your Log: when done.
  - Log:

## Coder B — Native core, protocol & firmware

Owns `core` native code (except the SHM substrate), `firmware/**`, and
the protocol-v2 host+MCU surface — the synced-capture lineage: bench
readiness, P3.1a/P4/P5 when hardware returns, FIN-trace diagnostics,
tracker/controller/dispatcher native work. The former "finisher" role is
retired: each coder fixes planner findings in their own area; quality
control is the planner's review loop.

### Active instructions

- **B-10 — optimization survey ROUND 2 (docs-only; NO code).** Wave-2
  landed the `PIXEL_FORMATS` single source, the production-writer bench,
  and streaming pyfovea. Re-survey `core/**` (minus C's ShmRing/reader),
  `firmware/**`, `pyfovea/**`, `app/orchestrator/recorder/**`,
  `playground/bench-recorder/**` + `docs/schema/**` for: (1) remaining
  duplication (e.g. does the `Controller.cpp` factory/packet boilerplate
  still want the B-P5-class treatment now that P1 proved the
  single-source pattern? does convert/PixelFormat have residual hand-kept
  lists the registry didn't reach?); (2) wordy internal names; (3)
  better-fit solutions. Write ranked proposals (max ~12) to
  `docs/refactor/proposals/B-r2.md`, ids `B-R2-P<n>`, same fields as
  round 1 (category non-breaking|breaking, rationale, effort, risk).
  **Do NOT re-propose** the deferred/declined set: B-P5 (declined), B-P6
  (post-bench), B-P11 (live load), B-P12 (shelved), B-P13 (Stage F),
  B-P14 (post-bench) — reference if adjacent. Note cross-role seams with
  C (codec/schema). Log a 3-line pointer under your Log: when done.
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
- **C-12 — optimization survey ROUND 2 (docs-only; NO code).** Wave-2
  landed `shm-client.ts` (pool extraction), the shared `ShmRead` native
  TU, streaming truncated playback, `shmReads` telemetry, viewer dedupe,
  and the decode-conformance suite. Re-survey the C-owned surface (shm
  path end-to-end, `metering.ts`, `orchestrator/viewer/**` +
  `sessions/viewer.ts`, shm blocks in client/protocol/StreamView) for:
  (1) duplication the extractions didn't reach (e.g. does StreamView's
  SHM OSD + the new telemetry share a formatter? is there overlap between
  `stats.ts`, `metering.ts`, and the new `shmReads` block?); (2) wordy
  names; (3) better-fit solutions the new module boundaries enable. Write
  ranked proposals (max ~12) to `docs/refactor/proposals/C-r2.md`, ids
  `C-R2-P<n>`, same fields as round 1. **Do NOT re-propose** C-P12
  (gated on future raw/16-bit shm) — reference if adjacent. Flag any
  cross-role codec/schema seam with B. Log a 3-line pointer under your
  Log: when done.
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
