# Split of Work — dispatch & log interface

> **This file is the only planner↔coder interface.** All other
> `docs/refactor/*.md` files are the planner's own tracking — coders do
> not edit them (this supersedes any older instruction to "log under
> Stage 4 in orchestrator.md"). Design specs still live there; active
> instructions below link to them read-only.

## Planner

The planner (Claude session directed by Yuxuan) owns everything about
this effort except writing the implementation itself:

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

**Dispatch mechanics:** workers are Codex sessions launched headless by
the planner via `scripts/dispatch-worker.sh <A|B|C> ["note"]`
(`codex exec`, workspace-write sandbox — repo-confined writes, no
network; transcripts under `.worker-logs/`, gitignored). **Sessions are
persistent per role** (user preference — warmup is costly): the first
run records the role's session id under `.worker-logs/session-<role>.id`
and later runs `codex exec resume` it with a short re-entry prompt, so
workers keep their context across iterations. Every run still begins by
re-reading this file's role section (steering first) — the file remains
the source of truth even with warm context. The planner retires a
role's session (deletes the id file) at stage boundaries to cap context
growth. The planner runs the script in a background shell and is
re-invoked on worker exit to start the verification iteration. At most
one session per role at a time; roles may run concurrently because the
ownership table keeps their file domains disjoint.

**Standing gates (every instruction, unless it narrows them):**
`vue-tsc --noEmit -p tsconfig.json` → 0 errors; `vitest run` all green;
`vite build` fully green; renderer bundle **zero-core**; orchestrator
bundle **zero-Vue**; `core make build` both runtimes when native code is
touched; reader addon `otool -L` shows system libraries only; built
`preload*.cjs` contain **no relative imports** (`grep -E
'(from |require\()"\./' .dist/electron/preload*.cjs` must be empty —
sandboxed preloads cannot load sibling chunks, V11) and preloads stay
`.cjs`/CJS (unsandboxed windows load `.mjs` as real ESM where bare
`require` throws, V11b). Tree stays
uncommitted — the user commits at planner-declared checkpoints. `npx`
and direct shell commands are permitted for type checking, builds, and
test scripts (all run inside the workspace-write sandbox; network access
— e.g. `npm install` — is not available).

## File ownership

Exactly one owner per path; touching a file you don't own requires a
planner-logged handoff (ask via your log, don't just edit).

| Path | Owner |
|---|---|
| `app/modules/**`, `app/src/**`, `app/lib/**` (except below) | A |
| `app/orchestrator/**` (except `registry.ts` while Stage 4 active) | A |
| `app/electron/main.ts`, `preload.ts`, `bridge.ts` | A |
| `app/test/**` (except SHM suites) | A |
| `app/orchestrator/registry.ts` (Stage 4 duration only, then back to A) | C |
| `app/electron/preload-shm.ts`, `preload-common.ts` | C |
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

- **A-standby.** No active instructions. A-1 (V7 target placement +
  V10 steering fix) planner-accepted 2026-07-06, archived to
  orchestrator.md §6. No queued A items — the planned 12-bit UI half
  turned out to already exist (selector landed 2026-06-05).
  - Log:

## Coder B — Native core, protocol & firmware

Owns `core` native code (except the SHM substrate), `firmware/**`, and
the protocol-v2 host+MCU surface — the synced-capture lineage: bench
readiness, P3.1a/P4/P5 when hardware returns, FIN-trace diagnostics,
tracker/controller/dispatcher native work. The former "finisher" role is
retired: each coder fixes planner findings in their own area; quality
control is the planner's review loop.

### Active instructions

- **B-standby.** No active instructions. B-1 (preview-safe pixel-format
  filtering — 12-bit readout now code-complete end to end) and B-2
  (serial-trace decoder + fixture) planner-accepted 2026-07-06,
  archived to orchestrator.md + synced-capture.md. Known cleanup
  candidate for a future round: pre-existing TS errors in `core/test`
  (`03-ArUco`, `08-shm-ring` — the latter is C-owned). Hardware items
  stay rig-gated.
  - Log:
- **(B-3 accepted & cleared 2026-07-06** — core/test typecheck now
  fully green combined with C-4.)

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
- **C-3 (held).** PB2 live measurement (orchestrator.md §7.1 Stage 4
  Round C) — needs display + cameras and planner acceptance of C-1/C-2
  first. Do not start.
  - Log:
