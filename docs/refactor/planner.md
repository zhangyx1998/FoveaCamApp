# Planner Handover

> For the incoming planner (Opus session). Written 2026-07-06 by the
> outgoing planner (Fable session) at HEAD `767c393` on
> `refactor/decouple-orchestrator`, tree clean except this file and two
> queued-instruction doc edits. Everything below is current as of that
> commit. Read this end to end before dispatching anything.

## 1. Your role

You are the **planner** for a multi-agent refactor of FoveaCamApp. You
do everything except write the implementation:

- **Sequence & scope.** You decide what work exists, split it into
  instructions, keep each coder's active set small and collision-free.
- **Spec.** Design records live in the planner docs (§3 below); you
  distill them into dispatch-ready instructions in `split-of-work.md`
  (scope, spec pointer, DoD, empty `Log:` slot).
- **Verify.** Every iteration: check every coder log **against the
  actual code**, re-run all gates yourself (**never trust a reported
  gate** — coders run them concurrently against moving trees), file
  defects as findings (severity, concrete failure scenario, fix spec).
  Claimed-but-absent work is a finding.
- **Steer & release.** `Steering:` notes under instructions that need
  fixes; next phase only after current issues resolved. Accepted
  instruction+log pairs: archive the essentials into the planner docs,
  then DELETE them from split-of-work.md — that file stays short.
- **Docs follow every steering decision (user directive 2026-07-06).**
  Whenever the plan changes course — a user direction, a finding that
  reorders work, a design decision — update the relevant planner doc in
  the SAME iteration, not retroactively. The docs are the plan; if they
  disagree with reality, that's a planner defect.
- **Escalate.** You do not commit unless the user says to (they decide
  checkpoints; you may prepare/execute the commits when told). You do
  not run hardware. Contract-level tradeoffs (preview quality vs cost,
  security-mode changes) are surfaced as explicit user decisions.
- **Planner hotfix exception:** when the user is blocked live and
  workers are unavailable/slow, you may implement small, fully-specced
  fixes directly — log them transparently under the relevant steering
  entry (precedent: V11 series, V13).

## 2. The dispatch loop (how coders run)

Workers are **Claude Sonnet 5 subagents** (switched from Codex
2026-07-06 after quota exhaustion), spawned via the harness Agent tool
with `model: "sonnet"`, `run_in_background: true` — you are re-invoked
on completion. Continue a role's existing agent with SendMessage (warm
context, the analog of the old codex-resume); spawn fresh only as a
deliberate cold start. Their kickoff prompt lives in the dispatch call —
keep it aligned with the split-of-work Protocol section (steering-first,
ownership, log-back, gates, node_modules/.bin + /opt/homebrew/bin/node
shell guidance — workers inherit this environment's broken zsh
wrappers). Transcript = the agent's returned final message; logs land in
split-of-work.md as before. (Legacy Codex path:
`scripts/dispatch-worker.sh`, retired but kept for reference; its
session-id files in `.worker-logs/` are stale.)

**Roles** (full definitions + file-ownership table in
`split-of-work.md` — that table is yours to maintain):
A = app/sessions/renderer/Electron shell (non-shm). B = core native
(non-shm), firmware, protocol v2. C = the shm frame path end-to-end
(incl. `registry.ts` while Stage 4 is active).

## 3. Document map

- `split-of-work.md` — **the only planner↔coder interface.** Protocol,
  standing gates, ownership table, active instructions + logs.
- `orchestrator.md` — main planner tracking: architecture (§3 incl.
  hard rules), locked decisions (§4), findings ledger (§6: RT1,
  V1–V13, PB1–PB3), roadmap/stage records (§7).
- `synced-capture.md` — protocol v2 / firmware thread (hardware-gated;
  P4.1 FIN-timeout root cause still undetermined, bench decides).
- `verification-playbook.md` — the user's staged hardware checklist;
  Session PB2 at the top is runnable with display+cameras only.
- `multi-window.md`, `workload-metering.md`, `recorder-container.md` —
  the Stage 5 program (user direction 2026-07-06): requirements +
  design notes per workstream; not yet dispatched.
- `stream-hot-path.md`, `async-reactive.md` — historical reference.
- `preload-error.md` — a resolved user-filed incident (V11c), keep.
- Coders never read instructions from or write to any of these except
  split-of-work.md.

## 4. Standing gates (run ALL of them yourself at every acceptance)

From `app/`: `../node_modules/.bin/vue-tsc --noEmit -p tsconfig.json`
(0 errors) · `../node_modules/.bin/vitest run` (all green; 72 tests at
handover) · `../node_modules/.bin/vite build` (no error/warn) ·
renderer bundle grep: no `core/(Aravis|Vision|Tracker|Controller)`,
`MarkerDetector` in `.dist/renderer/assets/*.js` · orchestrator bundle:
zero `defineComponent|createElementBlock` in
`.dist/electron/orchestrator.js` · **V11 preload triplet** on
`.dist/electron/preload-{renderer,profiler}.cjs`: no relative imports
(`(from |require\()"\./`), CJS content (starts `"use strict"`), zero
`baseURI|import_meta|createRequire` hits.
From `core/`: `make build` (grep -icE "error|fail" == 0, both
runtimes) · `/opt/homebrew/bin/node core/test/08-shm-ring.ts` (must be
that absolute node path — see §6 shell bug; needs unsandboxed shm_open)
· `otool -L core/dist/.bin/electron-*-shm-reader.node` = libc++/
libSystem only · `node_modules/.bin/tsc --noEmit -p
core/test/tsconfig.json` (0).

## 5. State at the hardware wall (2026-07-06, supersedes the handover state)

**Everything hardware-free is DONE and committed through `eca38d8`.**
All three coder roles are on standby with empty queues. Remaining work
by what it needs:

**A. User at the machine, display + cameras (no rig):**
1. GUI smoke of Stage 5 (rounds 1–3): boot→welcome (annotations ready
   for the user's SVG positioning pass), app open/switch/drain +
   refusal-while-recording, Apps menu, projection windows off the
   expand button (+ fullscreen titlebar in all four transitions),
   Cmd-Shift-R restore (incl. `?step=` state), plain Cmd-R inert,
   HMR: Vue edit hot-patches / protocol edit full-reloads.
2. Record → open the `.fovea` in the viewer (scrub/play/rate/
   truncated badge) → `pyfovea inspect/export` the same file. That
   chain end-to-end is the recorder stage's acceptance.
3. PB2 (playbook top section): shm loop-lag target < 5 ms vs PB1's
   47 ms; V12 check (profiler opens → mirrors parked, fps holds);
   profiler workload rows sanity; 12-bit format-switch plumbing check.
**B. User decisions:** full-res recording tier (gates writer
sharding); `.fovea` extension + `pyfovea` name (planner placeholders);
PyPI publish (deferred; after manual verification on real recordings);
electron-builder appId placeholder + first packaging run (also
verifies the file association).
**C. Rig-gated (playbook stages B–H):** firmware bench (P4.1
FIN-timeout diagnosis — decoder tooling ready), v2 flash, P4 wiring,
P5 integration, ST-64 flood, 12-bit debayer-noise A/B, multi-fovea
live tracking.

## 6. Environment gotchas## 6. Environment gotchas (each cost real time — respect them)

- **This shell's zsh is broken** (FUNCNEST/`__work` wrapper): bare
  `node`/`npx` invocations may explode. Use `node_modules/.bin/*`
  directly and `/opt/homebrew/bin/node` (v26.4.0 — matches the built
  addon) for core tests. Workers' shells are fine.
- **cwd drifts between Bash calls.** Repeatedly caused
  FileNotFoundError/127 failures mid-script. Start compound commands
  with `cd /Users/yuxuan/Lab/FoveaCamApp &&`.
- **Doc edits via python heredoc with `assert t.count(old)==1`** — the
  docs get reformatted by coders/prettier between your reads; re-grep
  exact current text before every edit; if an edit chain dies midway,
  check which edits landed before re-running.
- **V8 memory cage** (`-DV8_MEMORY_CAGE`, Electron builds only, set in
  `core/scripts/make.cjs`): external buffers can't be wrapped as JS
  ArrayBuffers; `ShmSlot.view()` is a cage-local READ SNAPSHOT under
  Electron and a live view under Node — **node-green ≠ electron-green**
  is a standing review trigger for anything `#ifdef V8_MEMORY_CAGE`.
- **Raw C++ throws from plain NAPI `InstanceMethod`s abort the
  process** — wrap bodies in `try { } JS_EXCEPT(...)` (house pattern).
- **Sandboxed preloads** can't require sibling chunks; unsandboxed
  ones load `.mjs` as real ESM (no `require`) and vite's
  `import.meta.url` shim resolves to the dev-server URL inside
  preloads. Hence: per-entry builds, CJS pinned via `build.lib`, the
  V11 triplet gate. Never re-introduce a shared runtime module between
  preload entries without per-entry builds.
- **Electron windows:** main = `sandbox: false` (loads the shm reader
  addon), profiler = sandboxed. That asymmetry is a user-approved
  decision; don't "fix" it.
- **`onView` sinks must return fast** (§3 hard rule, PB3): they run
  synchronously inside the registry camera loop.
- **Copy-before-await** on any reused/tap buffer; stale-async
  completions need generation/staleness guards (V5, V10, V13 were all
  this class — check for it in every review of async code).
- repo `.clang-format` has a key current clang-format rejects; C++ is
  manually formatted. Don't let workers block on it.
- User's snapshots: `~/Library/Application Support/fovea-cam-app/
  perf-snapshots/`. PB1 baseline = `2026-07-05T19-34-52-251Z.json`.

## 7. First actions for you

1. Read `split-of-work.md` fully (protocol + ownership + queued
   A-4/A-5), then orchestrator.md §3 hard rules, §4, §6 findings.
2. When Codex quota resets (~22:09): dispatch A
   (`scripts/dispatch-worker.sh A "PB3 round: A-4 and A-5."`, background
   shell), verify on exit per §1/§4, steer or accept, archive + clear,
   then ask the user to commit (suggested: one commit for the PB3 fix
   round).
3. When the user reports the V12 check / PB2 run: analyze the snapshot
   against the targets in the playbook's PB2 section (< 5 ms mean
   orchestrator loopLag, retries ≈ 0), file PB2 in orchestrator.md §6,
   close the downscale-lever decision (§7.1), and if green declare
   Stage 4 done.
4. Keep the habit that caught V8/V9/V13 before they shipped: read the
   diff of every native/concurrency change yourself; the harness
   passing is necessary, never sufficient.
