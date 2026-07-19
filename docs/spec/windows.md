# Windows, lifecycle & orchestrator instances — behavior spec

Behavior contracts for the multi-window shell and per-app orchestrator
lifecycle: `app/electron/main.ts`, `window-manager.ts`, `window-manifest.ts`,
`orchestrator-instances.ts`, `orchestrator-exit.ts`, and the renderer window
hosts under `app/src/windows/**`. Source files carry `// spec:` pointers here.

## Window manager state machine {#window-manager}

`window-manager.ts` — main-process window state machine, deliberately
Electron-free: every platform effect goes through injected deps (`spawn` creates
the real BrowserWindow in main.ts; `drainSessions` asks the orchestrator to idle
every camera-owning session and waits for settlement; `notifyRefusal` surfaces a
busy refusal). Unit-tested with fakes (`test/window-manager.test.ts`).

Adopted defaults:

1. **Welcome rule** — Welcome CLOSES on app open, respawns when the last app
   window closes. Only an APP window closing respawns it (closing welcome itself
   must not), and never mid-switch (the gap between "A closed" and "B spawned" is
   not "no app open") or during quit.
2. **App exclusivity + switch** — opening app B while A is open is a SWITCH: drain
   A's session FIRST, then spawn B. "Closed" means session-idle-drained, not
   window-destroyed. Refuse (keep A) only if A is mid-capture/recording. The drain
   happens BEFORE the old windows close so the busy check can refuse while A is
   intact; a drained session makes the subsequent close's unsubscribe a no-op.
   Welcome is camera-holding (live previews), so welcome→app rides the same path as
   app→app. Switches serialize (`switching` promise) so a second openApp queues
   behind one mid-drain.
3. **Switch inheritance** — the new window lands on the same bounds +
   fullscreen/maximized state as the window it replaces (both directions). The
   app→welcome direction reads a last-known snapshot because the BrowserWindow is
   destroyed by the time the welcome rule fires.

Window identity: `spawn()` is the single chokepoint. It resolves a stable
`windowId` (recovered from a restored URL, else minted `<appId|class>-<n>`,
unique among LIVE windows) and ALWAYS stamps it into `search` as `?win=` — the
packaged build loads `entry + search` (a restored `url` is only honored on the
dev origin), so `search` is the one slot carrying the id in every mode. The id
survives reload + manifest restore, and the renderer reads its own identity from
it. Composition namespaces `win/<windowId>/...` on it.

Sub-windows: a window may declare an `owner`. On owner close, the child's
class `onOwnerClose` policy decides `cascade` (close with owner — the debug
drawer, the sole cascade class) or `survive` (stay with a frozen last frame —
projection/viewer). `toggle`/`toggleDebug`/`openDebug` are the keyed
open/focus/close primitives; `kind` in the dedupe key `debug:<session>:<kind>`
lets one session own more than one debug window (debugger AND capture-preview).

Window classes and their singleton/exclusive/welcome-counting behavior live in
`@lib/windows` (`WINDOWS` table); openers: `ensureWelcome`, `openConfig`,
`openTeleCanvas` (singletons), `openProfiler` (per-instance keyed — see
[profiler binding](#profiler-binding)), `openViewer` (one per file),
`openProjection` (0..N, survives source close), `openApp` (exclusive + drain).

## Manifest & dev restart {#manifest}

`window-manifest.ts` — snapshot/restore of the open window set for the dev restart
flow (Ctrl/Cmd-Shift-R, dev only). `collectManifest` snapshots every open window;
`saveManifest`/`consumeManifest` persist it one-shot; `restore` re-spawns the plan
(profiler recovers its per-instance binding from the persisted URL and opens
straight into the frozen "session ended" state — the instance is gone after a
restart and must never re-attach). Dev restart relaunches the whole app so the
orchestrator boots fresh; production blocks reloads/navigation. Plain Ctrl/Cmd-R
is reserved for the recorder trigger in every mode.

## Disposable orchestrator instances {#instances}

`orchestrator-instances.ts` — the typed instance registry (Electron-free +
unit-tested); the fork/port/janitor wiring is injected from main.ts. Each app
activation forks a FRESH orchestrator `utilityProcess` that owns `core` (cameras,
vision, control, hardware I/O). Closing/switching the app disposes it: bounded
drain-and-quiesce → ack/timeout → kill → janitor. Teardown errors die with the
process, so the Welcome launcher never wedges.

- **Hardware gate** — the registry enforces ≤ 1 hardware instance (Aravis is
  per-process exclusive). `hardwareAlive()` pauses the enumerate-only probe and
  broadcasts the live-session banner.
- **Clean-vs-crash** — decided by the `quiesced` ack, NEVER the exit code. A clean
  exit acks after MEMS-disable + camera-release; any exit without that ack is a
  crash → the janitor runs.
- **Brokering** — main brokers a direct `MessagePort` between each
  renderer and its instance; frames/commands then flow point-to-point. A window
  BOUND to an instance (an app window that owns it, or an attached profiler) routes
  to THAT instance only; if its instance is dead, fail CLOSED (replay the typed down
  report, broker no port — a profiler must never connect to another session). An
  UNBOUND window (projection/debug) routes to the CURRENT live instance.

## Profiler per-instance binding {#profiler-binding}

A profiler pins to ONE instance. It is registered as an observer ATTACHMENT, never
an owned window — closing it can't dispose the instance, and the instance's death
can't close it (it freezes with its accumulated data, "session ended/crashed"). The
binding rides the URL (`instance` + `session` params) so it survives reload/restore
and the connect broker routes fail-closed to it. Keyed by `instanceId`: re-clicking
the chart icon for the SAME live instance re-focuses its profiler; a NEW app opens a
SECOND profiler. Opened from the status-only Welcome (no live instance) it is
unbound → "no active session".

## Hardware quiescence & crash safety {#quiescence}

Safety invariant: MEMS mirrors + cameras must NEVER stay armed past orchestrator
death, even on crash. Three nested nets:

1. **Quiesced handshake** — an instance confirms `quiesced` (MEMS disabled +
   cameras released) before a graceful exit.
2. **Janitor** — a one-shot cleanup `utilityProcess` (`orchestrator/janitor.ts`)
   forked by main on ANY non-clean instance death: fresh process, fresh device
   claims, disables the MEMS controller over serial, stops every camera's
   acquisition (also clearing TLParamsLocked for the next instance). Deduped —
   one run covers everything armed by the dead orchestrator.
3. **Detached watchdog** — a sibling process (`janitor.js` in `watchdog` mode,
   `ELECTRON_RUN_AS_NODE` so it outlives main and can load `core`) that reads a
   per-main-pid state file and polls main's liveness. On CLEAN shutdown main deletes
   the file first (stand-down). If main dies with the file present, the watchdog
   waits for the orphaned orchestrator to be reaped, runs the same quiescence, and
   exits. It never keeps the app open, never fights the normal janitor path (that
   runs only while main is ALIVE; the watchdog acts only after main is GONE).
   Closes gap 1: main's own hard crash (SIGKILL/SIGSEGV) reaps the orchestrator
   with nothing left to disarm the mirrors (releasing a serial port does not
   de-energize them).

Quit path — WINDOW-FIRST teardown: close owned sub-windows (cascade),
then app/top windows, let their teardown (pipe reads, `window:closed`) flush
BEFORE the instance handshakes so no renderer is mid pipe-read while an instance
disarms; then flush viewer engines, then quiesce every instance (bounded), then
kill the probe + stand the watchdog down. All waits bounded so a stuck window/hung
quiesce can't stall quit over armed hardware.

## Crash diagnostics {#crash-diagnostics}

`orchestrator-exit.ts` + `crash-report.ts` + `log-ring.ts`. The orchestrator (and
ONLY the orchestrator) is forked with PIPED stdio; every chunk is tee'd faithfully
to the parent terminal while a per-instance `LogRing` keeps a bounded tail (~256
lines / 64 KiB). Electron's `crashReporter` writes LOCAL-only minidumps (never
uploaded) to a stable dir under userData. On a non-clean exit, `enrichDownReport`
flushes the ring to a file, inlines a tail, and pairs the newest minidump whose
mtime is at/after the instance's fork time (best-effort attribution — multiple
instances share the dir). The enriched report is remembered per instance so a
late-attaching profiler replays the same frozen banner, and pushed to the dying
instance's OWNED + ATTACHED windows only (scoping) — a new instance's app
window must never react to the old instance's death.

## Config store authority {#config-store}

MAIN is the single config-store authority. `StoreMain` owns the cache + fs +
broadcast; renderer windows talk to it over `store:*` IPC, orchestrator instances +
the probe over their parentPort. A per-instance store-hub could not see across
instances. Settings / TeleCanvas windows are singleton, UNBOUND, orchestrator-free
— their store goes straight to MAIN, so a config edit applies live across every
window with no instance to back it. Main itself sets `FOVEA_DATA_PATH` for its own
process (not just children) so its reused fs primitives resolve the store root.

## Push safety {#push-safety}

A push to a dying window is correct to DROP, never fatal: `orchestrator:down` can
throw "Render frame was disposed before WebFrameMain could be accessed" while the
parent restarts. `pushTo` guards `isDestroyed()` AND wraps `send` — the render
frame can be disposed between the check and the send (webFrameMain race that
`isDestroyed()` won't catch). Log at debug; never throw.

## File association {#file-association}

`.fcap` (current) + `.fovea` (read-only legacy) open one viewer window per file.
macOS delivers via `open-file` (can fire BEFORE `whenReady` when the app is
launched by the file — pre-ready paths queue until the window manager can spawn);
Windows/Linux via argv → the `second-instance` handler (single-instance lock).
