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
- **Escalate.** You do not commit unless the user says to (they decide
  checkpoints; you may prepare/execute the commits when told). You do
  not run hardware. Contract-level tradeoffs (preview quality vs cost,
  security-mode changes) are surfaced as explicit user decisions.
- **Planner hotfix exception:** when the user is blocked live and
  workers are unavailable/slow, you may implement small, fully-specced
  fixes directly — log them transparently under the relevant steering
  entry (precedent: V11 series, V13).

## 2. The dispatch loop (how coders run)

Workers are **Codex CLI sessions** (the user's account), launched
headless by `scripts/dispatch-worker.sh <A|B|C> ["note"]`:

- Run it via a **background shell** so you're re-invoked on exit.
- Sessions are **persistent per role** (`.worker-logs/session-<X>.id`;
  delete the file to force a cold start — do that at stage boundaries
  to cap context growth). First run sends the full kickoff; resumes
  send a short re-entry prompt (steering-first).
- Transcripts land in `.worker-logs/` (gitignored). The worker's log
  entries land in `split-of-work.md` under its instruction.
- **Quota:** Codex hit its usage limit 2026-07-06 midday; resets
  ~22:09 local. Until then dispatches fail with a usage-limit error in
  the transcript.
- Quirks learned: `codex exec resume` takes no `-C`/`-s` flags (cd
  first; sandbox via `-c 'sandbox_mode="workspace-write"'` — already
  handled inside the script). Workers may use npx freely. At most one
  session per role; roles may run concurrently (ownership table keeps
  domains disjoint) BUT they all write logs to split-of-work.md — a
  concurrent-write clobber hasn't happened yet; if it does, restore
  the lost log from the transcript and consider per-role log files.

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

## 5. State at handover

**Committed (all planner-verified):** Stage 3 complete (multi-fovea,
scheduler, async KCF, V7 placement); contextIsolation flipped; Round 3
fixes; **Stage 4 complete through Round D** — shm is the ONLY frame
transport (registry + all session frames publish descriptors over
per-topic rings; `FOVEA_SHM_STREAMS` flag retired; bridge/clone
fallbacks deleted); V12 passive subscriptions; V13 cage write path;
12-bit readout code-complete; serial-trace decoder tooling.

**Queued, NOT yet dispatched (quota):** `A-4` (disparity async
tracker) + `A-5` (latest-wins onView processing gate) — the PB3 fix
round, fully specced in split-of-work.md. Dispatch A when quota
resets; verify per §1; expected outcome is registry serials back at
camera rate with session-processed topics at own capacity.

**Held:** `C-3`/PB2 measurement (user at bench, display+cameras);
projector window (user product decision pending); shm adoption beyond
previews (capture/raw/12-bit stay on existing paths); everything
hardware-rig-gated (playbook stages B–H, bench, v2 flash, P4/P5).

**Waiting on the user:** V12 live check (idle app → open profiler →
60 fps holds, mirrors parked); PB2 script run (snapshot via
Ctrl+Shift+S **in the main window with inspector mode on** — the
profiler window's export has an empty renderer-frames table); camera
format currently ~1.5 MB/frame vs PB1's 6.22 MB (decide: restore
format for strict comparison, or file PB2 as new baseline).

**Open findings:** PB3 (fix queued A-4/A-5). Everything V1–V13 is
fixed & verified; PB1 superseded by Stage 4; PB2 pending measurement.

## 6. Environment gotchas (each cost real time — respect them)

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
