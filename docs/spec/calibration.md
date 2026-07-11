# Calibration data model — behavior spec

Behavioral contracts for the calibration record model and the calibration-data manager.
Source pointers are per section; the code carries only load-bearing invariants inline.

## Calibration records {#calibration-records}

Source: `app/lib/calibration-records.ts`
(`docs/proposals/calibration-records-v2.md` + its AS-BUILT store-schema-v2 addendum)

A calibration RECORD is the per-camera replacement for the flat calibration document.
Both kinds — EXTRINSIC (per-fovea datapoint array) and INTRINSIC (center-camera solve) —
share one model:

- IMMUTABLE inner data (`RecordInner`) — the raw payload the record is built from. This is
  the HASH PRE-IMAGE: the record `id` (its primary key AND store filename) is a truncated
  SHA-256 (32 hex digits — `RECORD_ID_HEX`) of a canonical, key-sorted serialization of
  `inner`. Pure + deterministic → the same payload always yields the same id, across
  sessions/platforms, so a record imported from another rig collides with an identical
  local one (import then just ADDS an association).
- MUTABLE outer metadata (`RecordMeta`) — associations (camera-instance ⇄ triple bindings),
  a creation timestamp (latest-first ordering key), an optional label, and (for aggregates)
  the source record ids. Editing the outer metadata NEVER changes the id (only the inner
  data does).

Records live in per-kind store directories, keyed by their 32-hex id: extrinsic →
`["calibrate-extrinsic", <id>]` (`EXTRINSIC_STORE`), intrinsic →
`["calibrate-intrinsic", <id>]` (`INTRINSIC_STORE`). Schema v2 removed the flat
`calibration-records/` directory; the v1→v2 migration moved every record into its per-kind
directory and truncated the id, and wrapped legacy `calibrate-intrinsic/<cameraKey>`
CameraCalibration docs as intrinsic records (see `store-migrations.ts`).

This module is PURE (no store IO, no Vue, no core/): the config window, the orchestrator
load path, and the store-migration framework all inject their own IO around these
functions, and every function here is unit-testable with plain objects. `sha256` is the
only async dependency (WebCrypto, available in both renderer and node/main).

## Calibration-data manager {#calibration-data}

Source: `app/lib/calibration-data.ts`

Calibration-data enumeration + friendly-naming for the config window's "Calibration data"
manager. Every persisted calibration document lives under one of three store directories:
`calibrate-intrinsic/<id>` (intrinsic record), `calibrate-extrinsic/<id>` (extrinsic
record), `triples/<hash>` (per-triple config doc: drift_l/drift_r, zoom_override,
baseline_mm, …).

Schema v2: both `calibrate-*` directories hold hash-keyed records. `.raw` analysis
artifacts may also sit there and are skipped. `<id>`/`<hash>` are 32-hex truncated
SHA-256; the triple hash is of the L/C/R camera keys (mirrors
`orchestrator/calibration.ts`'s `tripleConfigPath` — kept in lockstep here because that
module is Vue-free / core-importing and must not be pulled into the renderer).

The store is injected (`CalStore`) so this is unit-testable with an in-memory fake; the
config window passes the renderer `Store` client (`list`/`read`/`clear`). Reads use the
one-shot `Store.read` (no subscription) since this is a management view over many docs.

## Marker tracker {#marker-tracker}

Source: `app/orchestrator/marker-tracker.ts`
(`docs/history/refactor/orchestrator.md` §7.1 S1b)

Orchestrator-side port of the renderer's `calibrate-extrinsic/tracker.ts` (`Tracker` class
+ `actuate()`), shared by calibrate-extrinsic, calibrate-distortion, and calibrate-drift —
the original was cross-module-imported by all three, so it lives here as orchestrator infra
(like `calibration.ts`) rather than co-located in one consumer module.

Vue-free port: the original class used `ref`/`shallowRef`/`computed` for its public getters
and `EventTarget`/`dispatchEvent` for the "new detection" signal — replaced with plain
fields and a callback-list (`onDetection`), matching every other session's style. Runs its
own `detector.stream(camera.stream, scale)` consumer, the same concurrent-raw-stream pattern
calibrate-intrinsic's marker mode established for the "MarkerDetector only takes a raw
Frame/Stream<Frame>, not a Mat" constraint.

## Marker-calibration primitives {#marker-calibration}

Source: `app/orchestrator/marker-calibration.ts`

Small, Vue-free primitives shared by the marker-calibration sessions (calibrate-extrinsic,
calibrate-drift, calibrate-distortion). Each of the three independently stood up an identical
L/C/R `MarkerTracker` triple, the same `target ? { points } : null` detection overlay, the
same per-tracker `onDetection` wiring, teardown, and `setTargetId` retarget — with the tracker
scale/dictionary/`internal` constants copy-pasted three ways (drift dropping subpixel
refinement being the only real difference). Kept as a toolkit, not a session framework (same
discipline as `fovea-pipeline.ts`): each session still owns its own intrinsic/extrinsic data,
actuation mode, view taps, and extra telemetry — these helpers only remove the triple +
detection-publish + target-id boilerplate so the three can't drift on marker id, detector
dictionary, or fovea scale.

## Calibration visualizer {#calibration-visualizer}

Source: `app/lib/calibration-visualizer.ts`
(`docs/proposals/calibration-records-v2.md` §Visualizer)

Pure projection math for the extrinsic-calibration visualizer. For each recorded datapoint it
pairs the OBSERVED marker corners (as detected in the fovea image) with the PROJECTED corners
the calibration solve expects (the pinhole model's take on where those object-space corners
land). The gap is the reprojection residual the visualizer draws (observed dots vs projected
crosses + connecting error segments). Reuses the existing calibration math from
`findPinholeProjection` via the core-free `projection-geom` module (so it runs in a renderer
without native code); it does NOT re-derive camera math — it is the same construction stopped
one step earlier (observed vs the projected target, before the homography regression smooths
across poses).

## Live triple baseline {#triple-baseline}

Source: `app/lib/triple-baseline.ts` (per-triplet-settings wave, Ruling A)

RENDERER-ONLY composable: the LIVE per-triple stereo baseline (mm) for the calibrate-* marker
overlays. The session publishes the leased triple's config store path; this opens that same
`["triples", <hash>]` document reactively via `Store.open`, so a Settings-window edit to the
triple's `baseline_mm` (or an app-level `baseline_distance_mm` edit) reflects in the open
calibration window's marker spacing live. The resolution order lives in the shared, Vue-free
`resolveBaseline` (triple > legacy app > 200) so renderers and orchestrator agree by
construction. Vue-importing → renderer-only; do NOT import from a session.ts.

## Marker-projection geometry {#projection-geom}

Source: `app/lib/projection-geom.ts`

Pure marker-projection geometry, extracted from `@lib/marker` so it can be shared by CORE-FREE
contexts (the renderer's calibration visualizer) as well as the core-importing `marker.ts`
(which re-exports these). Everything here is plain arithmetic over `Point2d`/`Point3d`
(type-only imports, erased at build → no `core/` at runtime): the single source of truth for
the pinhole marker model — obj-space corners, bilinear corner interpolation, relative→absolute
placement, and the rotate-and-perspective-project used to synthesize the calibration solve's
projected corners. Do NOT duplicate these — import from here.

## Coordinate conversions {#coordinate-conversions}

Source: `app/lib/coordinate-conversions.ts`

Coordinate conversions for a calibrated fovea triple — angle ⇄ voltage (per fovea,
drift-corrected), angle ⇄ wide pixel (intrinsic undistort), and angle → homography. Pure math
over the loaded calibration objects, shared by the renderer and the orchestrator control
loops. Inputs are described structurally (`ConversionInputs`) so both the renderer's
`CalibratedTriple` and the orchestrator's loaded triple satisfy it — neither side is coupled
to the other's loader types.

## Calibration overlay toggle {#calibration-overlay}

Source: `app/lib/calibration-overlay.ts` (calibration-records-v2 §Overlay)

Live cross-window state for the extrinsic-calibration overlay toggle. Rides a single store
doc (`["ui", "cal-overlay"]`) — MAIN is the config authority, so a toggle in the Settings
window is visible LIVE in a running calibrate-extrinsic view (or any StreamView for the
target camera) with no bespoke IPC. The overlay renderer is the SAME component as the
standalone visualizer; this doc only says WHICH record to draw and for WHICH camera.
