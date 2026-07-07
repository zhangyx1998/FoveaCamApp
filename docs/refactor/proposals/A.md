# Coder A optimization proposals

Survey scope: A-owned app/module/orchestrator/Electron surface, excluding C-owned SHM/viewer/metering blocks. Ranked by expected value.

## A-P1. Resource-scoped session lifecycle

Locations: `app/orchestrator/runtime.ts`; camera-owning sessions in `app/modules/*/session.ts` (`tracking-single`, `manual-control`, `disparity-scope`, `multi-fovea`, `calibrate-*`, `manage-cameras`, `single-capture`).

Current -> proposed: each session hand-rolls `triple`/`leases`, `disposers`, `loop`, `activateSession()`, `idleSession()`, ready telemetry, and sometimes async drains. Add a runtime/helper layer such as `defineResourceSession` where `activate(scope)` returns resources/cleanup, the scope owns disposers, an activation generation token, ready telemetry, and ordered async drain.

Category: breaking.

Rationale: the pattern appears in at least 9 sessions, and prior defects were lifecycle/staleness bugs: V1 drain ordering, V5/V10 stale async completion, RT1 handoff, PB3 worker cancel timing. Centralizing the lifecycle gives one place to enforce "activate completed after idle must dispose itself" and "idle waits before releasing leases".

Effort: L.

Risk: high. It changes session runtime semantics and every hardware session's activation path; needs strong unit coverage plus GUI/hardware verification.

## A-P2. Move tracking-single display vision onto frame workers

Locations: `app/modules/tracking-single/session.ts`; compare `manual-control/session.ts` and `disparity-scope/session.ts`.

Current -> proposed: tracking-single now uses `AsyncKcfTracker`, but center undistort/slice and fovea wrap/diff/depth still run synchronously inside registry `onView` taps. Adopt `createFrameWorker` for center and L/R fovea processing, with named workload meters and idle cancellation matching manual-control/disparity.

Category: non-breaking.

Rationale: PB3 already established the cost of ms-scale synchronous `onView` work, and the orchestrator doc still calls tracking-single a residual. This keeps the hard rule consistent across the last affected module.

Effort: M.

Risk: medium. Timing of tracker init/update and frame-age telemetry must stay coherent; hardware fps check needed.

## A-P3. Shared triple/fovea view pipeline helper

Locations: `tracking-single/session.ts`, `manual-control/session.ts`, `disparity-scope/session.ts`.

Current -> proposed: each control session duplicates `ORIGIN`, `radians`, `clampRect`, `aligned` L/R cache, `publishSlicedView`, `publishCombinedView`, `depthWindow`, wrap-enable display selection, and 33 ms voltage telemetry throttling. Add a Vue-free helper module under `app/orchestrator/` or `app/modules/shared/` for common fovea display pipelines and throttled actuation telemetry.

Category: non-breaking.

Rationale: at least three long sessions carry near-identical control/display scaffolding, and their subtle differences make fixes uneven (manual/disparity got frame workers; tracking did not). A helper reduces future skew.

Effort: M.

Risk: medium. The sessions differ in target semantics, so the helper should expose small primitives rather than a large framework.

## A-P4. Marker-calibration session helper

Locations: `calibrate-extrinsic/session.ts`, `calibrate-drift/session.ts`, `calibrate-distortion/session.ts`.

Current -> proposed: three sessions separately build L/C/R `MarkerTracker`s, detection telemetry, `setTargetId`, optional override state, `startServo`/actuation loops, and role frame publishing. Extract helpers for tracker triples, `DetectionView` publishing, target-id updates, and drift/extrinsic/distortion-specific actuation modes.

Category: non-breaking.

Rationale: the same `target_id` contract/state and `publishDetections()` structure appears across all three calibration sessions. A shared helper would reduce marker-id and detector-option drift.

Effort: M.

Risk: medium. Calibration tools have different ownership of intrinsic/extrinsic data, so helper boundaries must not hide those differences.

## A-P5. Frame channel binding helper for renderer modules

Locations: renderer views in `app/modules/**/index.vue`, `app/src/windows/ProjectionWindow.vue`, `WelcomeWindow.vue`, `ViewerWindow.vue`.

Current -> proposed: views repeatedly write `const frameL = session.frame("L")`, `frameC`, `frameR`, dynamic computed frame refs, and manual `StreamView` wiring. Add `useFrames(session, ["L", "C", "R"])` returning a typed record, plus optional `useDynamicFrame(session, keyRef)` for projection/welcome/viewer dynamic channels.

Category: non-breaking.

Rationale: `rg` shows repeated `session.frame(...)` declarations across at least 10 renderer surfaces. A helper cuts boilerplate and makes finterest/dynamic-frame behavior easier to audit.

Effort: S.

Risk: low. It is renderer-only and can be adopted incrementally.

## A-P6. Split StreamView/FrameView responsibilities

Locations: `app/src/components/StreamView.vue`, `FrameView.vue`, `FrameOverlay.vue`.

Current -> proposed: `StreamView` owns payload materialization, fps/timing meters, inspector overlay, projection addressing, and passes through display props; `FrameView` owns canvas conversion, sizing, title chrome, capture hooks, fullscreen/projection button, pointer translation, and SVG annotations. Split into smaller pieces: `FrameCanvas`, `FrameChrome`, `FrameInspector`, `ProjectionButton`, and a thin compatibility wrapper.

Category: non-breaking.

Rationale: the two main components are roughly 280 and 480 lines and have accreted Stage 5 projection and SHM OSD behavior. Smaller pieces make future OSD/projection/capture changes less likely to collide.

Effort: M.

Risk: medium. This is UI plumbing with many call sites; visual regression and projection-window checks are needed.

## A-P7. Normalize orchestrator contract names to camelCase

Locations: contracts and call sites under `app/modules/**`, `app/lib/orchestrator/contracts.ts`, `app/src/**`.

Current -> proposed: mixed wire names use snake_case (`target_id`, `wrap_enable`, `depth_window_inv`, `active_serial`, `record_count`, `capture_busy`, `recording_streams`, `reset_tuning`, `set_pid`) while newer app code tends to short camelCase (`drainSessions`, `publishViews`, `frameRate`, `openApp`). Rename wire fields/commands to camelCase: `targetIds`, `wrap`, `depthWindowInv`, `activeSerial`, `recordCount`, `captureBusy`, `recordingStreams`, `resetTuning`, `setPid`, etc.

Category: breaking.

Rationale: mixed naming raises cognitive cost at every renderer/session boundary and encourages long names because fields carry transport-era wording. A single project voice makes contracts easier to scan.

Effort: M.

Risk: high. All renderer/session call sites and stored URL/state references must move together; stale persisted state may need migration if any key is saved.

## A-P8. Window class table for main/window manager

Locations: `app/lib/windows.ts`, `app/electron/main.ts`, `window-manager.ts`, `window-manifest.ts`.

Current -> proposed: window taxonomy is split across `WindowClass`, `entryFor`, `allEntries`, `windowOptions`, singleton/dedupe logic, restore switch, manifest normalization, and bridge IPC names. Add a `WINDOWS` table describing class, entry, singleton/dedupe key, counts-for-welcome, exclusivity, preload, sandbox, default bounds, and restore params.

Category: non-breaking.

Rationale: Stage 5 added welcome/app/profiler/projection/viewer quickly, and each new class now needs edits in 4-5 files. A table reduces missed invariants such as singleton status, preload mode, and welcome-rule participation.

Effort: M.

Risk: medium. Electron-specific options should stay in main, so the table may need pure metadata plus a main-side adapter.

## A-P9. Single app registry for catalog, loaders, and entries

Locations: `app/lib/windows.ts`, `app/src/windows/app-registry.ts`, `app/windows/*.html`, `app/vite.config.ts`.

Current -> proposed: app ids live in `APPS`, component loaders live in `app-registry.ts`, and every app has a separate HTML entry. Use one source of truth with generated/static-checked derived maps: `APPS` plus `import.meta.glob("@modules/*/index.vue")` for loaders, and a small script/test that verifies every app id has an HTML entry and module.

Category: non-breaking.

Rationale: adding/removing an app currently requires synchronized edits in multiple places. This is exactly the kind of Stage 5 growth point that drifts silently until build or runtime.

Effort: S.

Risk: low to medium. Vite static analysis can be picky; keep the current explicit loader map if `import.meta.glob` harms chunking, but add the consistency test either way.

## A-P10. Typed bridge IPC registry

Locations: `app/electron/bridge.ts`, `preload-bridge.ts`, `main.ts`.

Current -> proposed: bridge method names and IPC channels are duplicated manually (`window:open-app`, `window:open-projection`, `save-path:*`, `fs:*`, `perf-snapshot:write`). Add a small typed registry for channel names, argument tuples, and return types, then generate or validate the preload wrappers and main handlers from it.

Category: non-breaking.

Rationale: the V11 preload fixes show this surface is boot-critical, and hand-synced strings are easy to miss. A registry keeps the bridge narrow while making mismatches compile-time visible.

Effort: M.

Risk: medium. Must preserve V11: preload outputs stay self-contained CJS with no sibling chunks or `import.meta` shims.

## A-P11. Manage-cameras property schema

Locations: `app/modules/manage-cameras/contract.ts`, `session.ts`, `CameraConfig.vue`, `app/lib/camera-config.ts`.

Current -> proposed: camera properties are repeated across the contract type, native read guards, UI controls, persistence keys, and reset logic (`pixel_format`, frame-rate fields, exposure/gain/black-level groups). Add a schema of camera controls with getter/setter key, availability key, range key, auto-mode key, units, formatter, and persistence behavior.

Category: non-breaking.

Rationale: one property family takes several synchronized edits. A schema would also make welcome annotations reuse the same labels/formatters instead of hard-coding frame-rate/exposure/gain display separately.

Effort: M.

Risk: medium. Native getters can throw or be unavailable; the schema must keep the existing `safe()` behavior.

## A-P12. Explicit stream address instead of mutating `FrameMeta`

Locations: `app/lib/orchestrator/client.ts`, `app/lib/orchestrator/protocol.ts`, `StreamView.vue`, `FrameView.vue`, projection windows.

Current -> proposed: `useSession().frame()` mutates each received payload's `meta.source` client-side so `StreamView` can open a projection without prop-threading. Replace with an explicit wrapper shape such as `{ payload, source }` or a `FrameRef` object that carries the address alongside the ref while keeping wire `FrameMeta` transport-only.

Category: breaking.

Rationale: overloading `FrameMeta` with client-only UI address mixes transport metadata and renderer routing. It worked for Stage 5, but the payload mutation is surprising and makes the protocol type document data that never crosses the wire.

Effort: M.

Risk: high. It touches every `session.frame()` consumer and C-owned SHM materialization expectations, so planner arbitration is required.

## A-P13. Activation errors as session telemetry

Locations: `app/orchestrator/runtime.ts`, `diagnostics.ts`, all session `activateSession()` implementations, renderer module loading states.

Current -> proposed: failed activation mostly sets `ready: false` and logs diagnostics out of band. Add a standard `error`/`status` telemetry convention or runtime-provided `fail(reason)` helper seeded to new subscribers, with optional retry/clear behavior.

Category: non-breaking.

Rationale: RT1 and camera contention failures are currently visible mainly in logs. A standard user-visible activation failure state would make window switching and hardware setup failures easier to diagnose without watching stderr.

Effort: M.

Risk: low to medium. Contracts do not all have an error field today; adding one broadly is additive but UI adoption is per-module.

## A-P14. Short rename pass for local variables

Locations: scattered in A-owned files, especially long-lived Stage 5 additions.

Current -> proposed: keep public wire names out of scope unless covered by A-P7, but shorten local names where the project already favors compact nouns. Rename map: `orchestratorDown -> orchDown`, `selectedSerial -> serialPick`, `currentProjection -> projection`, `previewTarget -> previewVolts`, `frameCenterDisparity -> disparityFrame`, `frameCenterSliced -> slicedFrame`, `recordable -> canRecord`, `pixelFormatBusy -> formatBusy`, `activeSubscribers -> active`, `telemetrySnapshot -> telemetry`.

Category: non-breaking.

Rationale: long local names grew during the refactor to encode context in names. Shorter names fit nearby code like `ready`, `views`, `loop`, `leases`, `drain`, `publishViews` once functions/components already provide context.

Effort: S.

Risk: low. Cosmetic, but should be batched with nearby functional work to avoid noisy diffs.
