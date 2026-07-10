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

## AS SHIPPED (W2, 2026-07-09) — disposable orchestrator per app instance

Implements RE-AMENDED ruling 2. The singleton orchestrator is GONE: opening an
app forks a fresh orchestrator process; closing/switching disposes it. Teardown
errors die with the process, so the Welcome launcher (which now depends on
NOTHING in a dying instance) never wedges — the whole class of teardown-wedge
faults is contained by process disposal.

### Instance registry (as built)

`app/electron/orchestrator-instances.ts` — a pure, Electron-free state machine
(`OrchestratorInstances`), injected-wiring like `window-manager.ts` /
`viewer-engine.ts`, unit-tested at `test/orchestrator-instances.test.ts`. Typed
table of `{id, kind: "hardware" | "non-hardware", proc, phase, hardwareCleared,
quiesced, expected, janitorDone, windows}`. This wave forks exactly one consumer
— the per-app `hardware` instance — but the `non-hardware` type + the
≤1-hardware-holder gate land ready for the viewer's future compute instance (the
no-core-exception retirement is a later wave; the typing is here).

- **Phases**: `live` → `draining` (shutdown sent, bounded quiesce armed) →
  `dead`. A hardware instance also carries `hardwareCleared` (has main granted
  acquisition?).
- **Death classification** reuses `classifyOrchestratorExit` (ack-based, never
  exit-code guessing) per instance; `shouldRunJanitor` fires the janitor on
  every non-clean instance death.

### hardware-clear gate sequencing

1. Open app → `spawnWindow(app)` calls `registry.open("hardware")` immediately
   (core load + graph build overlap the previous instance's teardown) and claims
   the app window.
2. The new hardware instance is forked with acquisition DEFERRED. The
   orchestrator arms a module-level gate at boot (`orchestrator/hardware-gate.ts`,
   `armHardwareGate()`); every device-opening chokepoint —
   `registry.acquire`/`acquireMany` and `controller.connect` — awaits
   `awaitHardwareClear()` before touching a camera / the MEMS serial. The gate is
   disarmed by default so unit tests never block.
3. Main grants hardware-clear (`sendHardwareClear` → the orchestrator's
   `signalHardwareClear()`) only when **every other hardware instance is
   confirmed dead AND released** — clean ack (released in-process) OR janitor
   sweep complete (`hardwareReleased(rec) = dead && (quiesced || janitorDone)`).
   The ≤1-holder gate: at most one hardware instance is ever cleared.
4. While an acquisition is blocked on the gate, the orchestrator surfaces a named
   **"waiting for previous session to release hardware…"** step on the `system`
   session's spin-up progress; `AppWindow.vue` observes `system` status alongside
   the app's own so the overlay shows why spin-up pauses. Cleared the instant
   main grants hardware-clear.

### Close / switch / crash / quit (per instance)

- **Switch**: `drainSessions` (window-manager dep) busy-checks + best-effort
  drains the outgoing instance (`window:drain`, refuses on mid-capture/recording)
  then `registry.teardown` it (shutdown → ack → kill, ~4s bound → janitor). The
  new instance forks separately and defers hardware until the outgoing one is
  dead + swept. The Welcome window depends on neither, so it never blocks.
- **Close app → Welcome**: the app window's close disposes its instance
  (`registry.onWindowClosed` → teardown when the last owned window is gone).
- **Crash mid-actuation**: non-clean exit → `classifyOrchestratorExit` = crash →
  janitor sweep + a typed `orchestrator:down` **scoped to the dying instance's
  owned windows** (`registry.windowsOf` → `webContentsByWindowId`), so a NEW
  instance's app window never reacts to the OLD instance's death (the old
  broadcast-to-all + client self-scope was insufficient once >1 instance exists).
- **Full quit**: window-first teardown order preserved (`manager.closeAll` →
  windows destroyed → `viewerEngines.killAll` → `registry.teardownAll` → await all
  dead, bounded) → kill probe → watchdog stand-down → `app.quit`.
- **darwin window-all-closed / PARK**: RETIRED. With no app window there is no
  hardware instance at all (closing the app window already disposed it), so
  nothing is held headless; `parkHardware` + the `park` message are removed.
- **devRestart**: `registry.teardownAll` + bounded wait + kill probe → relaunch;
  the probe respawns in the relaunched main.

### Watchdog (main-hard-crash cover)

Kept as ONE detached watchdog for main's lifetime; its state file now carries the
CURRENT set of live instance pids (`orchestratorPids: number[]`, refreshed on
every instance open/exit via `onLivePidsChange`). On a main crash it waits for
EVERY listed orphan to be reaped before quiescing (`janitor.ts` watchdog reads
the array; legacy single-`orchestratorPid` still accepted). One watchdog covers
0..N instances because the janitor disarms ALL hardware in one fresh-process
sweep — no need for one watchdog per instance.

### Welcome window + probe

Welcome is status-only. Deleted: the camera-holding `manage-cameras` session, the
`usePipeFrame` live preview, the annotation canvas, and the camera picker. Added:
the logo, a connection status row, and a live camera list fed by a new **probe**
(`orchestrator/probe.ts`) — a small persistent utilityProcess main forks at
startup (its OWN tiny Node entry, not the orchestrator binary in a flag-mode, so
it pulls in none of the session graph — just `core/Aravis` + a cheap store-hub
role read). It enumerates every ~2s (`Camera.list()` then releases every handle —
never a lease/stream), posts `{cameras}` to main on a real change
(`cameraListChanged`), and main forwards it over the `probe:cameras` bridge push.
Roles come from saved config (store-hub read). The probe holds no hardware, gates
nothing, outlives app instances, is restarted by main if it dies, killed at quit,
and is **paused while a hardware instance is alive** (registry
`onHardwareAliveChange`) so its background `Camera.list()` never contends with an
app's exclusive acquisition; resumed back at Welcome. The pure list-diff + status
derivation live in `app/lib/orchestrator/probe.ts` (Vue-free, shared by probe /
main / renderer, unit-tested at `test/probe-camera.test.ts`).

### Per-instance state re-derivation (confirmed correct)

Each app instance starts from a clean slate — store-hub cache, controller holder
+ StreamIdPool, clock-calibration registry, and the pipe broker/registry all
re-derive per instance (they are process-local). All re-derivable ⇒
correctness-safe; the costs are latency (native addon reload + camera re-lease)
and **clock re-convergence** (the owner threads re-calibrate init + 30s drift on
each activation — the accumulated drift-ppm is thrown away). Clock
re-convergence right after each switch is EXPECTED behavior under this model, not
a bug.

### Deltas from the ruling

- `orchestrator:down` is scoped to the dying instance's OWNED (claimed app)
  windows, not broadcast-to-all. Sub-windows/projections that connected to a dead
  instance are not separately notified (they freeze — the existing survive
  behavior); the app window, where `CrashReport.vue` mounts, is the guaranteed
  target.
- The connect handshake brokers to `registry.connectTarget()` (the current live
  app instance). With no app instance up, `orchestrator:connect` is a no-op — the
  status-only Welcome never connects; a profiler/projection opened with no app up
  has nothing to attach to until an app opens.
- No fork→ready span was newly added; the existing per-instance `boot.*` spans
  (`FOVEA_FORK_TS` stamped per fork) still report spin-up timing — read them on
  the rig for the spawn-latency reading.

### Profiler per-instance binding (2026-07-09 follow-up)

The Profiler window is adapted to the disposable model (user ruling: "a profiler
instance should be assigned a session id to profile into … may outlive the app
for preservation of debug logs, but should not attempt to connect to another
session … should have the session name and id in the title bar").

- **Bind at open, immutable for life.** The profiler-open path
  (`open-profiler-window`) resolves `registry.currentHardware()` and stamps
  `{instance, session}` into the profiler window URL (`PROFILER_INSTANCE_PARAM` /
  `PROFILER_SESSION_PARAM`, `@lib/windows`). Instances now carry a human
  `sessionName` (the activating app id — `registry.open("hardware", appId)`). The
  window is registered as an observer **attachment** on that instance
  (`registry.attachWindow`) — NOT an owned window, so closing the profiler can't
  dispose the instance and the instance's death can't close the profiler.
- **Connect routing pins the instance; fails CLOSED.** `orchestrator:connect`
  resolves the sender's `registry.boundInstance(windowId)` (owned app OR attached
  profiler). A bound window routes to THAT instance only; if it is already dead
  the broker replays the typed down report (`lastDownReports`) and brokers NO port
  — it never falls back to another instance (the "never connect to another
  session" rule). Unbound windows (projection/debug) still route to the current
  instance. This supersedes the blanket `connectTarget()` routing noted above for
  bound windows.
- **Keying + survive policy.** Profiler is no longer a `singleton` — it is 0..N,
  one per instance. `WindowManager.openProfiler` keys by `profiler:<instanceId>`:
  re-clicking the chart icon for the same LIVE instance re-focuses its existing
  profiler; a new app (new instance) opens a SECOND profiler. `onOwnerClose:
  survive` (already set) keeps it open past its app; app-quit still closes it
  (`closeAll`). Multiple profilers coexist, each pinned to its own (possibly dead)
  instance; `planFromManifest` restores every one (each re-opens straight into the
  frozen state — the instances are gone after a restart, and it must not
  re-attach).
- **Frozen session-ended UI.** When the bound instance goes down, the down report
  reaches the profiler (attachments are notified alongside owned windows), sets
  `orchestratorDown`, and the profiler STOPS polling (no reconnect, no console
  spam) while keeping all accumulated graphs/meters/clocks/spans browsable. A
  layout-stable banner distinguishes a clean/killed end ("Session ended", neutral)
  from a `crash` ("Session crashed", danger tokens) off the SAME typed report.
  Snapshot export needs a live orchestrator, so it is disabled with a tooltip when
  dead (reveal-folder still works). The title bar shows `session · #shortId` (pure
  helpers in `src/profiler/binding.ts`).
- **Gates (follow-up).** `vue-tsc --noEmit` clean; `vitest` full suite green
  (700, +13: registry attach/bound/sessionName, profiler per-instance keying,
  `profiler-binding` formatting); `vite build` clean. Rig items in
  stage-f.md §"Disposable orchestrator" (profiler survives frozen, two pinned
  profilers, crashed-vs-clean banners).

### Gates

`vue-tsc --noEmit` clean (for the files in scope). `vitest`: the 2 new suites
(`orchestrator-instances` 13, `probe-camera` 9) pass; full suite green for
everything in scope. `vite build` clean — new Node entry `probe.js` (1.5 kB)
alongside `orchestrator.js` / `janitor.js`.
