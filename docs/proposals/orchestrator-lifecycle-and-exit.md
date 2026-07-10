# Orchestrator lifecycle + exit sequence — per-app-instance process, audited teardown

Status: **RE-OPENED (2026-07-09): ruling 2 RE-AMENDED to disposable-per-app-instance — see §RE-AMENDED below; the 60793fb singleton hardening (watchdog, ack, park, crash reports) carries forward as the per-instance building blocks**. Builds on the
hardware-quiescence invariant (janitor + quiesced handshake, 4f8e016;
exit-6 HandleScope fix 26871e4) — this program AUDITS and EXTENDS that
work; it must never regress kill()-only teardown.

## Rulings (user, 2026-07-09)

1. **Exit sequence audited**: the main process must ensure ALL dangling
   windows and the orchestrator process are cleared before terminating
   itself — no orphaned utility/debug/viewer windows, no orphaned
   orchestrator, on ANY exit path (quit menu, last-window close, SIGTERM,
   relaunch).
2. **Orchestrator process recreated per app instance**, so cleanup is
   guaranteed by process death, not by in-process teardown bookkeeping.
   **AMENDED (user, 2026-07-09, post-audit)**: keep ONE persistent
   orchestrator process; close the audit's five gaps instead (main-crash
   janitor coverage, darwin window-all-closed teardown, crash-report
   surface, deterministic clean-exit handshake, window-first quit order).
   Per-app-instance recreation rejected on the audit's economics — native
   addon reload + camera re-lease + clock re-convergence on every app
   switch buys cleanup the janitor already provides.
   *Planner reading (flag at dispatch if wrong)*: one orchestrator process
   per app ACTIVATION — launching an app (manual-control, multi-fovea, a
   calibrate tool…) gets a fresh orchestrator; closing the app's window(s)
   ends that process. Camera/MEMS exclusivity already serializes hardware
   apps, so a fresh process per activation costs only startup latency
   (measure it; pre-warm a standby process if it matters). Viewer windows
   are exempt by design — they no longer touch the orchestrator
   ([standalone-viewer-and-fcap](./standalone-viewer-and-fcap.md) ruling 1).
3. **Graceful exit notifies main FIRST**: before the orchestrator exits
   gracefully it reports cleanup completion to the main process (extend
   the existing quiesced handshake to a main-visible "clean-exit" ack), so
   main can distinguish clean death from crash death deterministically —
   never by exit-code guessing alone.
4. **Crash exit**: main sends a crash report to the windows associated
   with the orchestrated task (the app windows + their owned sub-windows —
   the WINDOWS-table owner pointer scopes "associated") and spawns a
   cleanup worker to enforce hardware quiescence (the janitor pattern;
   audit that the janitor covers the per-app-instance model and every
   crash path — signal, abort, native fault).

## RE-AMENDED ruling 2 (user, 2026-07-09) — disposable orchestrator per app instance

The singleton amendment is REVERSED. Rig experience with the persistent
process: any error in teardown wedges the shared orchestrator and the
Welcome window stops responding — no app can be entered. Process disposal
is the only containment that covers the whole class of teardown faults
(including ones not yet found — cf. the Stream close deadlock, fixed
`ee6fc46`, which froze the app exactly this way).

1. **One orchestrator instance per app activation.** Opening an app forks
   a fresh instance; closing/switching the app ends that process:
   bounded drain-and-quiesce → ACK or timeout → kill → janitor sweep.
   Teardown errors die with the process; every app starts from a clean
   slate (no cross-app thread/lease/memory residue).
2. **Latency hiding**: the NEXT app's instance may fork (core load,
   init) while the previous instance is still tearing down — only
   CAMERA/MEMS ACQUISITION gates on the old instance's confirmed death +
   janitor completion (Aravis is per-process exclusive). The spin-up
   progress monitor absorbs the wait and names the gating step.
3. **Welcome window is status-only** (user-ruled): live camera list +
   connected state via an enumeration-only probe (never opens a camera,
   holds nothing, no teardown on app entry); logo instead of live video.
   Resolves ux-review E7. The probe may be a small persistent
   enumerate-only process — it touches no hardware state, so it can
   outlive app instances and never gates anything.
4. **Typed instances** (user-ruled direction): instances declare
   `hardware` (claims cameras/MEMS — at most one alive at a time) or
   `non-hardware` (node-graph compute only — N may run alongside a
   hardware instance). This is what makes the model pay twice over: the
   VIEWER can spin up a non-hardware instance next to an active camera
   session — running its own node graphs over a recording and dispatching
   projector windows for its own session — and thereby stops importing
   core outside the orchestrator entirely: the ruled no-core-exception
   (standalone-viewer-and-fcap ruling 1) is RETIRED as a goal state; core
   lives ONLY in orchestrator instances. (The viewer migration itself is
   a follow-up wave, not part of the lifecycle wave; the instance typing
   must land ready for it.)
5. Rulings 1, 3, 4 above carry over unchanged, re-read per-instance:
   clean-exit ack per instance, crash report scoped to the instance's
   owned windows, janitor on every instance death path, watchdog covers
   main-crash for whichever instances are alive.

## Audit checklist (the wave's first deliverable, before code)

- Enumerate every exit path in `main.ts` (menu quit, Cmd-Q,
  window-all-closed, second-instance handoff, macOS dock quit, updater
  relaunch if any) and every orchestrator death path (clean exit, kill,
  crash signal, exit-6-class native faults) → a matrix of "who cleans what,
  verified how". Document in the proposal's AS-SHIPPED.
- Verify window teardown ORDER: sub-windows (cascade policy) → app windows
  → orchestrator handshake (ruling 3) → main exits. A hung orchestrator
  must not hang quit: bounded wait, then kill + janitor.
- Verify the janitor runs on EVERY non-clean path and is itself
  crash-safe (spawn-early or spawn-on-demand — audit which).

## Interactions

- Per-app-instance recreation (ruling 2) changes broker/registry
  assumptions ONLY if any state was assumed process-persistent across app
  switches — the audit must list such state (store-hub caches, controller
  holder, clock calibration) and pin per-instance re-derivation as correct.
- Crash reports to windows (ruling 4) need a small bridge channel + a
  renderer surface (toast/dialog in affected windows) — reuse the
  orchestrator-down notification path (`client.ts onOrchestratorDown`) as
  the transport seed.

## Execution

W1 audit (read-only matrix + gaps list, planner-reviewed) → W2 per-app
lifecycle + handshake + crash report + janitor extension, with soak-style
tests (spawn/kill orchestrator repeatedly, assert no orphan windows/
processes, quiescence held). Rig: stage-f §"Hardware quiescence" gains
re-verify items under the per-app-instance model (crash mid-actuation →
mirrors parked, cameras released, crash report shown).

## Audit (W1, 2026-07-09)

Read-only audit of the CURRENT committed state. VERIFIED = code read;
INFERRED = reasoned from code + Electron semantics, not exercised.

### Process model TODAY (the headline finding)

There is exactly ONE long-lived orchestrator `utilityProcess`, NOT one per
app instance. `startOrchestrator()` is called only twice:
`app.whenReady().then(startOrchestrator)` (`main.ts:638`) and lazily
`if (!orchestrator) startOrchestrator()` inside the `orchestrator:connect`
handler (`main.ts:372`). No spawn is keyed to `openApp`. An app switch runs
`drainForWindowSwitch()` (`orchestrator/index.ts:431`) which idles/disposes
the camera-owning sessions and `releaseAll()`s leases, but the PROCESS, the
`Hub`, the store-hub cache, the controller node, the clock-calibration
registry, and the pipe broker/registry all PERSIST across activations.
=> Ruling 2 ("recreated per app instance") is NOT the shipped model. This is
the single largest gap of the wave.

### 1. Exit paths (main.ts)

| Path | Trigger | windows | sub-windows (cascade) | orchestrator | hardware |
|---|---|---|---|---|---|
| Graceful quit | `before-quit` `main.ts:648` (Cmd-Q / menu / app.quit) | `app.quit()` closes all (2nd pass, `:672`) | cascade via `onWindowClosed` (`window-manager.ts:187`) on each close | `shutdown` msg → 5s wait → `kill()`+2s (`:657-668`) | orchestrator quiesces; else `ensureJanitor("app quit")` `:669` |
| window-all-closed (non-darwin) | `main.ts:677` | `app.quit()` → routes to `before-quit` | via before-quit | via before-quit | via before-quit |
| window-all-closed (darwin) | `main.ts:680` (no-op) | none — app stays alive headless | none | **stays alive** | **stays armed** |
| second-instance | `main.ts:683` | focus/openViewer only | — | untouched | untouched |
| dock activate | `main.ts:697` | focus/ensureWelcome | — | untouched | untouched |
| dev relaunch | `devRestart` `main.ts:580` (Cmd-Shift-R, dev only) | `saveManifest`+relaunch; `app.exit(0)` closes all | cascade on close | `shutdown` msg → 2s → `kill()` `:597-602` | 2s graceful; **no janitor fallback** on this path |
| main crash (SIGKILL/SIGSEGV of main) | no handler | OS-reaped | — | orphaned/OS-reaped, **no `shutdown`** | **no janitor** (janitor is forked BY main) |

Notable exit-path gaps:
- **darwin window-all-closed leaves the orchestrator alive with armed
  hardware** (`main.ts:680`): standard macOS behavior, but under the safety
  invariant a headless app holding energized MEMS/streaming cameras with no
  window is exactly the orphan state ruling 1 forbids. GAP.
- **main's own crash spawns no janitor** (VERIFIED absence): the janitor is a
  child `utilityProcess.fork` from main (`main.ts:253`); if main dies hard the
  orchestrator is reaped without `shutdown` and NOTHING runs the janitor.
  INFERRED (utility children die with the parent, but without quiescence).
  This is the one path the current janitor design cannot cover.
- **devRestart has no janitor fallback** (`main.ts:595-603`): 2s race then
  `kill()` then `app.exit(0)`; a wedged quiesce on dev-restart leaves armed
  hardware until the relaunched controller re-disables as a backstop
  (comment `:601`). Dev-only, lower risk.
- **Quit ORDER is inverted vs the ruling-3 sequence**: `before-quit` sends
  the orchestrator `shutdown` FIRST (`:659`), then `app.quit()` closes windows
  (`:672`). Ruling wants sub-windows → app windows → orchestrator handshake →
  main exits. Both are cleared, but not in the audited order; a window still
  holding a live pipe read during orchestrator teardown is possible.

### 2. Orchestrator death paths

Detection: `orchestrator.on("exit", code)` (`main.ts:316`).

| Death | main detects | windows learn | hardware cleaned | user sees |
|---|---|---|---|---|
| Clean (`quiesceAndExit(0)`, `orchestrator/index.ts:470`) | exit code 0 | `orchestrator:down` push `main.ts:335` | already quiesced (`quiesced` msg `:486`); no janitor (`code===0` clean `:323`) | nothing (channel closes silently) |
| kill (quit timeout) | exit code≠0 | `orchestrator:down` | `ensureJanitor` `:324` | nothing user-visible |
| native crash (exit-6 / SIGABRT / SIGSEGV) | exit code≠0, `quiesced` never posted | `orchestrator:down` | `ensureJanitor` `:324` | **nothing** — `onOrchestratorDown` only closes the channel (`client.ts:157-159`); NO toast/dialog |
| JS uncaughtException | `quiesceAndExit(1)` `index.ts:502` → clean quiesce, exit 1 | `orchestrator:down` | quiesced in-process; `code≠0` so janitor ALSO runs (redundant but safe) | nothing |
| hang | bounded: 5s quit `:660`, 4s quiesce deadline `index.ts:473`, 10s drain `:350` | drains resolved `ok:true` `:328` | janitor after kill | nothing |

### 3. The matrix (rows × {win / orch / hw / main-notified / user-informed})

Legend: V=verified file:line, G=gap, N/A.

| Path | windows cleared | orchestrator cleared | hardware quiesced | main notified | user informed |
|---|---|---|---|---|---|
| Graceful quit | V `main.ts:672` (+cascade `wm:187`) | V `:657-671` | V `:669` janitor fallback | N/A (main drives) | G — silent |
| darwin all-closed | G — none | **G — stays alive** | **G — stays armed** | N/A | G |
| dev relaunch | V `:603` | V `:597-602` | G — no janitor fallback | N/A | G |
| main hard-crash | OS | **G — orphan/reap, no handshake** | **G — no janitor** | N/A | G |
| clean orch exit | via app.quit | V `index.ts:494` | V `index.ts:449-465` | V `main.ts:335` | G — silent |
| orch kill | V | V `:324` | V janitor `:324` | V `:335` | G |
| orch native crash | V (survive) | V `:316` | V janitor `:324` | V `:335` | **G — no report surface** |
| orch hang | V | V kill `:665` | V janitor | V | G |

### 4. Gaps vs the 4 rulings

**Ruling 1 (clear all windows + orchestrator before terminating):** MOSTLY
met on the quit path (`before-quit` clears both + janitor backstop), but (a)
order is orchestrator-first not window-first; (b) darwin window-all-closed and
(c) main's own crash both leave orphans. GAPS: b, c, and teardown order.

**Ruling 2 (orchestrator per app instance):** NOT the current model — one
persistent process (see "Process model TODAY"). State a per-activation
recreate would reset, with re-derivation safety:
- store-hub `docs` cache (`store-hub.ts:38` `Map`) — re-derivable from disk on
  first read; **safe** (cost: re-read + lost cross-window write-coalescing
  warmth).
- controller holder `active` + `StreamIdPool` (`controller.ts:475`, `:459`) —
  re-derived on next `controller.connect`; **safe** but forces a MEMS
  disable/re-enable + re-home on every activation (serial churn).
- clock-calibration registry (`clock-calibration.ts` → `time-align` setCalibration)
  — native owner threads re-calibrate (init + 30s drift) on reconnect;
  **safe but lossy**: the accumulated drift-ppm convergence is thrown away and
  must re-converge each activation (a real, measurable regression to timestamp
  quality right after every switch).
- pipe broker/registry `shared` leases + `closing` sets (`registry.ts:105-118`)
  and SHM pipe names — re-derivable via re-enumeration + re-lease; **safe**
  but pays camera enumeration + lease cost per activation.
- Hub per-window channel/`win/<id>` state — rebuilt on reconnect; **safe**.
All re-derivable => correctness-safe; the costs are latency + clock re-converge,
not data loss.

**Ruling 3 (graceful exit notifies main BEFORE orchestrator exits):** PARTIALLY
exists. `quiesceAndExit` posts `{type:"quiesced"}` (`index.ts:486`) BEFORE
`process.exit`, and main flips `orchestratorQuiesced` (`main.ts:291`). MISSING:
this is a quiesce ack, not a distinct "clean-exit" ack — main still
disambiguates clean vs crash by `code !== 0` (`main.ts:323`), exactly the
exit-code guessing the ruling wants replaced. The 100ms flush hack
(`index.ts:493`) + `code===0` fallback exist precisely because the ack can lose
the flush race. GAP: promote `quiesced` to a deterministic pre-exit clean-exit
handshake main keys on instead of the code.

**Ruling 4 (crash → report to task windows + cleanup worker):** cleanup worker
EXISTS and is solid — `ensureJanitor`/`runJanitor` (`main.ts:244-266`),
deduped, 10s-timed, fresh-process device re-claim (`janitor.ts`). It fires on
every non-clean orchestrator exit (`main.ts:324`). MISSING: the REPORT surface.
`orchestrator:down` carries no payload (`bridge.ts:118` `[]`) and the only
renderer handler closes the channel (`client.ts:157-159`) — no toast/dialog, no
scoping to the task's owner-associated windows. Also the janitor does NOT cover
the main-crash path (§1) — its spawner is dead.

### 5. W2 file map

- `app/electron/main.ts` — lifecycle rework: tie orchestrator lifetime to app
  activation (spawn on `openApp`, dispose on last app-window close) OR
  (cheaper) keep one process + document ruling 2 as amended; add darwin
  all-closed teardown; enforce sub-window→app→orchestrator→exit order in
  `before-quit`; add a `clean-exit` ack distinct from `quiesced` and key
  janitor decision on it not `code`; carry a crash payload on the down push;
  add a main-crash guard (external watchdog or pre-registered janitor).
- `app/orchestrator/index.ts` — emit `{type:"clean-exit"}` as the terminal
  pre-exit message (ruling 3); if per-activation is adopted, add a
  per-activation reset entry point (re-derive store/controller/clock/registry).
- `app/electron/bridge.ts` — widen `orchestrator:down` to
  `orchestrator:crash` with a payload `{reason, sessions?}` (ruling 4 report).
- `app/electron/preload-bridge.ts` — forward the crash payload to renderer.
- `app/lib/orchestrator/client.ts` — `onOrchestratorDown` surfaces a
  user-visible crash notice (toast/dialog) scoped to affected windows, beyond
  closing the channel.
- `app/src/windows/*` (app shell) — mount the crash-report surface.
- `app/orchestrator/janitor.ts` — audit-only confirms coverage; extend the
  main-crash trigger path (spawn-early / watchdog) if that gap is taken.
- `app/orchestrator/clock-calibration.ts` / `time-align.ts` — if per-activation:
  accept that drift re-converges; consider persisting last drift-ppm to warm-
  start.
- `test/` — soak test: spawn/kill orchestrator repeatedly asserting no orphan
  windows/processes and quiescence held (per Execution).
