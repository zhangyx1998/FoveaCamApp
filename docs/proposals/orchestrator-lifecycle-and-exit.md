# Orchestrator lifecycle + exit sequence — per-app-instance process, audited teardown

Status: **RULED (user 2026-07-09; awaiting dispatch)**. Builds on the
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
