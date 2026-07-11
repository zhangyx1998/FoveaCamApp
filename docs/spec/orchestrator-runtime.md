# Orchestrator runtime & lifecycle — behavior spec

Behavioral contracts for the orchestrator process runtime, sessions, and hardware
safety. Source pointers are per section; the code carries only load-bearing invariants
inline.

## Hardware janitor {#janitor}

Source: `app/orchestrator/janitor.ts`

The single hardware-safety codebase, run in two modes. Its whole job is the
hardware-safety invariant: the MEMS controller must never stay energized and no camera
may stay streaming/locked after the process that armed them is gone. Deliberately
minimal and forgiving — every step is best-effort with its own try/catch, the process
always exits 0 (main only logs the outcome), and a global deadline guards against a
wedged serial port or camera enumeration.

### Mode 1 — one-shot (default)

A utilityProcess the MAIN process forks whenever the orchestrator dies without confirming
quiescence (crash, abort, kill) and on final app quit. In-process handlers cannot cover a
SIGABRT/SIGSEGV — this runs in a fresh process, so it works no matter how the orchestrator
died (devices are claimed per-process; a dead owner's claims are already released by the
OS).

### Mode 2 — watchdog (`FOVEA_JANITOR_MODE=watchdog`)

A detached process main spawns early (via `ELECTRON_RUN_AS_NODE` so it outlives main) to
cover main's OWN hard crash — the one path mode 1 cannot, since its spawner would be dead.
It polls main's liveness against a per-main-pid state file (`FOVEA_WATCHDOG_STATE`). Clean
shutdown ⇒ main deletes the file first (stand-down). Main gone with the file still present
⇒ crash: wait for the orphaned orchestrator to be reaped (kill it if it lingers so its
device claims free), then run the same quiescence as mode 1. See main.ts's "Main-crash
watchdog" header for the process tree.

## Resource-scoped session lifecycle {#resource-session}

Source: `app/orchestrator/resource-session.ts` (A-P1)

Each activation gets a `ResourceScope` that owns the cleanups registered during
`activate` and drains them LIFO on idle. The scope enforces the two lifecycle invariants
that produced a recurring bug class in the hand-rolled sessions:

1. Ordered async drain (V1/RT1): `idle()` returns a promise that resolves only after
   every registered cleanup — including camera-lease releases and async drains — has run,
   LIFO. The runtime's `drained()` awaits it, so a window switch waits for the real
   teardown.
2. Stale-async-completion safety (V5/V10): if the session idles (or re-activates) while a
   slow `activate` is still running, that activation is superseded — every resource it
   acquires from then on is released immediately instead of leaking, and a re-activation
   serializes behind the prior drain so two activations never hold the leases at once.

Built on the A-R2-P1 `session-resources` primitives (DisposerBag/releaseLeases still used
inside `activate`); this adds the generation/drain machinery around them. Additive:
`defineResourceSession` sits alongside `defineSession`, so sessions migrate one at a time.

## Window/app catalog {#windows}

Source: `app/lib/windows.ts` (Stage 5, `docs/history/refactor/multi-window.md`)

The single source of truth for the multi-window foundation. Imported by the renderer
(welcome launcher, per-app window shell), the Electron main process (window manager entry
wiring), vite.config.ts (multi-entry renderer build), and the window-manager unit tests.
Must stay Vue-free and Node-free (pure data + string helpers) so every consumer can load it.

Window taxonomy (multi-window.md §2):
- `welcome` — singleton, the fallback when no app window is open.
- `app` — ≤ 1 at a time (apps are mutually exclusive over camera leases + the controller).
- `profiler` — 0..N utility; one per orchestrator instance, each pins to the app instance
  alive when it was opened and outlives it frozen; does not count toward the welcome rule.
- `projection` — 0..N single-stream viewers (passive subscribers, never exclusive, never
  counted for the welcome rule, survive their source app's close).
- `viewer` — 0..N recorder playback windows, ONE PER `.fcap`/`.fovea` file (non-exclusive,
  never counted for the welcome rule, STANDALONE: never touches the orchestrator —
  standalone-viewer-and-fcap ruling 1).

## Hardware-acquisition gate {#hardware-gate}

Source: `app/orchestrator/hardware-gate.ts` (disposable-orchestrator ruling 2)

A fresh orchestrator instance forks and builds its node graph IMMEDIATELY, but must not touch
the exclusive hardware (Aravis cameras, MEMS serial) until the PREVIOUS hardware instance is
confirmed dead + swept — main signals this with a "hardware-clear" message. Aravis is
per-process exclusive, so acquisition serializes even while spin-up overlaps the old
instance's teardown. Every hardware chokepoint (`registry.acquire`/`acquireMany`,
`controller.connect`) awaits `awaitHardwareClear()` before opening a device, so the deferral
is ONE gate, not scattered per-session. While something waits, the gate reports a "waiting"
state so the orchestrator surfaces a named progress step. The gate is DISARMED by default so
unit tests never block; the orchestrator process `arm()`s it at boot, then
`signalHardwareClear()` opens it exactly once. Vue-free.

## Camera-enumeration probe {#probe}

Source: `app/orchestrator/probe.ts` (disposable-orchestrator ruling 3)

A small persistent utilityProcess main forks ONCE at startup — separate from any app instance
— whose ONLY job is to load `core`, enumerate connected devices on an interval (~2s), and post
the plain list to main, which forwards it to the status-only Welcome window. It NEVER opens a
camera (only `Camera.list()`, which constructs + immediately releases handles), so it holds no
hardware, gates nothing, outlives every app instance, and is restarted by main if it dies. It
is its OWN tiny entry (not the orchestrator binary in a flag-mode) so it pulls in none of the
session graph. Main PAUSES it while a hardware app instance is alive (Aravis is per-process
exclusive) and RESUMES it back at the Welcome screen.

## Diagnostics (report / span) {#diagnostics}

Source: `app/orchestrator/diagnostics.ts` (`docs/history/refactor/orchestrator.md` §12.1 C7)

Process-wide error reporting for orchestrator code with no single owning session (the camera
registry is shared) or that would otherwise fail silently into the utility process's stdio.
`report()` always logs locally; `onReport()` lets `index.ts` forward reports to every connected
renderer once, at boot, so failures are visible without watching the orchestrator console.
`span()` is the S5 sibling: structured timing measurements (boot phases, per-activation
camera/calibration work, controller connect) instead of failures — same shape, always recorded
locally (bounded ring), forwarded via `onSpan()` so a future profiler window renders a live
timeline without polling.

## State-in-URL helper {#url-state}

Source: `app/lib/url-state.ts` (`docs/history/refactor/multi-window.md` req. 7 / §4)

Stateful windows expose internal state in their URL so a dev restart / manifest restore lands
back in the same internal state, not just the same window. The orchestrator session stays
authoritative — the URL is the ADDRESS of that state, not a second copy: components sync
state → URL with `history.replaceState` (no navigation, no history spam) and read the URL
once on load to seed the session. State rides the QUERY STRING, not a path subpath: packaged
windows load via `loadFile(file, { search })`, where a path subpath would break file://
resolution — the query string is the one URL slot that rides both the dev-server URL and the
packaged file URL unchanged. Renderer-only; framework-free (Vue callers wrap `writeUrlState`
in a `watchEffect`).

## TeleCanvas contract {#telecanvas}

Source: `app/lib/telecanvas.ts` (standalone dual-mode module, user directive 2026-07-09)

The TeleCanvas shared contract. Pure data — Vue-free AND Node-free — so every consumer can
load it: the renderer (config refs, the TeleCanvas window, the settings section), the typed
IPC bridge (`electron/bridge.ts`), and the main-side host manager
(`electron/telecanvas-manager.ts`). Two modes (config `tele_canvas_mode`): `client` — the app
PUTs its merged projection SVG to a configured REMOTE TeleCanvas server URL
(`tele_canvas_url`); the default. `host` — the app spins up its OWN TeleCanvas-compatible
server (a dependency-free node http server in a utilityProcess) on `tele_canvas_port`;
external displays open the served viewer page. The push path is unchanged — it just targets
`http://127.0.0.1:<port>/`.

## Unified time (time-align) {#time-align}

Source: `app/orchestrator/time-align.ts` (unified-time-and-topology §1–§3, RULED)

THE time origin is the orchestrator's steady clock (`process.hrtime.bigint`, integer ns,
monotonic). Every other clock — camera tick counters, the MCU's uint64 micros, Aravis wall
stamps — maps INTO host-ns via a calibrated offset estimated with the MIN-FILTER (ruling 1:
latency noise is one-sided; the minimum over N samples converges on the true offset, the mean
absorbs tail latency — PTP's trick). Consumers never see raw device time: they call
`toHostNs(clock, ts)` after boot calibration. Caveat owned here: hrtime PAUSES during system
sleep — `sleepDetected()` compares wall-vs-steady progress; a jump invalidates every
calibration.

## Native probes seam {#native-probes}

Source: `app/orchestrator/native-probes.ts` (A-24 Stage 3)

The free-running C++ threads — the SHM pipe producers (`Pipe.probeAll()`) and the KCF tracker
(`tk.probe()`) — expose native meters in the `WorkloadSnapshot` shape, probed OUT-OF-LOOP.
This tiny registry folds those probes into `system.perfSnapshot.workloads` alongside the JS
meters WITHOUT `system.ts` touching `core`: the orchestrator index injects `Pipe.probeAll`,
the tracking session injects its tracker's probe, and `system.ts` merges them. Keeps the
snapshot builder native-free (so its vitest keeps running) and lets the profiler render a
native producer/tracker stream identically to a JS one.
