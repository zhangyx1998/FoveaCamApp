# Manage Cameras

**Seed confidence: HIGH. Auditor: confirmed; preview-safe filtering verified
correct (lives in core, passed straight through).**

## Purpose
Camera inventory + per-camera configuration + live raw preview. The entry point
for verifying rig cabling/formats before running any app.

## Pipeline (post-real-1c)
`manageCamerasSession` opens EVERY connected camera at once (not one at a time):
`refresh` → `listCameraInfo`, bulk-lease new serials via `acquireMany` (per-serial
`openCamera` retry fallback for still-settling handoffs), close leases for
departed serials, and start a 1 Hz property poll (`publishViews`). Each camera's
raw BGRA8 preview rides its own `camera:<serial>` native pipe (renderer binds
`usePipeFrame`); the native converter thread produces the preview with ~0
orchestrator load — no JS loop, no vision worker. Config writes go through the
registry (`set`/`setPixelFormat`/`reset` commands) and persist per-serial
(`cameraConfigPath`); the registry applies stored config on open. A contended
camera surfaces `s.fail("Camera … in use by another process")`. `idle()` stops
the poll and releases all leases.

The 1 Hz snapshot (`readView`) reads every native getter through a `safe()` guard
(a camera can be force-released mid-poll; an unguarded read on a released
`CoreObject` would throw inside `setInterval` and crash the orchestrator), plus a
per-entry try/catch in `publishViews` so one bad camera drops from the tick
instead of killing the poll. Tunable controls come from the shared
`CAMERA_CONTROLS`/`readControlFields` schema (A-P11), with a compile-time drift
guard in `contract.ts` pinning `CameraView`'s control half to `CameraControlsView`.

## UI & controls
`index.vue` renders a `CameraConfig` per `telemetry.list` entry. `CameraConfig.vue`
(thin, no `core`): live preview (`StreamView` over the pipe payload) + role select
(L/C/R/none), pixel format select, frame-rate (manual/auto + slider), exposure
(auto mode + log10 µs slider), gain, black level — each fieldset shown only when
its `*_available` probe is true. Reset button restores auto defaults and clears
stored config. All edits route through the `set`/`setPixelFormat`/`reset` commands;
readout formatters come from the shared control schema so displayed values can't
drift from the wire.

## Expected behavior
Preview at camera rate with ~0 orchestrator load; 12-bit formats render correctly
(significantBits down-scale happens in the native converter); config changes apply
live and persist across restarts. Changing pixel format briefly pauses acquisition
(`reconfigure` stops the shared loop, mutates, restarts with a fresh reuse buffer;
the set is retried up to 30× to absorb the cross-thread stop).

## Known/suspected issues (auditor findings)
- (was: the 1-2s glitch + 12p purple stripes — both fixed and rig-confirmed)
- **Preview-safe pixel-format filtering (RESOLVED — correct):** the filtering is
  NOT in app code. `CameraView.pixel_format_options` is passed straight through
  from the native getter `Camera.get_pixel_format_options()`
  (`core/lib/Aravis/Camera.h`), which filters via `canViewAs(format, BGRA8)` —
  the SAME converter capability that produces the pipe preview. So the option
  list is, by construction, exactly the set the preview path can render; it
  cannot drift from the converter after the refactor. (Filtering is in core →
  outside this audit's edit lane; noted as verified, nothing to change.)

## Open questions (for the user)
- None outstanding. (Verification that `canViewAs`/converter and preview agree for
  every listed 12-bit format is RIG-GATED, but the code-level guarantee is sound.)
