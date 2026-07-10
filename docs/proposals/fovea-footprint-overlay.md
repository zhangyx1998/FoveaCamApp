# Fovea footprint overlay + free-run recorded extras (proposal)

Status: CODE-COMPLETE (2026-07-10, `7692e9d`). Two coupled deliverables (user direct
request); pure parts unit-tested, gates green (vue-tsc + vitest). Rig pass owed
(the recorded homography direction is the same open question flagged in
`homography-feeder.ts` — see below).

## Part A — free-run extras via interpolated actuation history

Today only TRIGGER-mode multi-fovea frames get `angle`/`affine` (from the FIN
pairing anchors — `app/modules/multi-fovea/recording.ts` `anchorExtras`,
`volt.source: "fin-averaged"`). FREE-RUN frames recorded no per-frame extras.

The orchestrator ALREADY keeps a generic, timestamped actuation history:
`app/orchestrator/mirror-history.ts` — a ring written by the controller node's
`predictVolts` path and read in REALTIME by `homography-feeder.ts`
(`H(mirrorAt(frameHostNs))`). It needed no change: it is already generic and
already used at runtime. Part A builds ON it.

- At record time, for each free-run L/R fovea frame on a CALIBRATED triple, the
  recorder samples `mirrorHistory.mirrorAt(frameHostNs)` (the trusted host-ns of
  the frame, ruled invariant) and derives:
  - `volt`   = the interpolated mirror voltage for that eye,
    `volt.source: "history-interpolated"` (a NEW `VoltSource`, additive —
    distinct from `fin-averaged`);
  - `angle`  = `V2A[side](volt)`;
  - `affine` = `A2H[side](angle)` — the SAME volt→angle→H chain the display /
    homography-feeder path applies, so the recorded H matches the live one.
- `mirrorAt` → null (empty/too-old history) ⇒ the frame is omitted (never a
  guess). Uncalibrated triple ⇒ `conversions()` → null ⇒ angle/affine omitted
  (the existing rule; here the whole extras doc is omitted since there is no FIN
  volt either).
- A trigger anchor, when present, still WINS over the history fallback.

Wiring: `historyExtras()` (pure, exported, unit-tested) in
`multi-fovea/recording.ts`; the controller gains `mirrorAt` + `conversions`
deps, wired in `multi-fovea/session.ts` from the orchestrator-wide
`mirrorHistory` and the active triple's `conv`.

Scope note: the generic `raw-recording.ts` facility records the full-sensor
`camera/<serial>/raw` streams (disparity-scope + calibrate wizards), NOT fovea
crops, and carries no controller pose — Part A does not apply there (a
full-sensor footprint is not a fovea footprint). Left untouched.

### Baseline metadata

The container did not record the triple's stereo baseline. Added additively:
`multi-fovea/session.ts` `wideCameraMeta()` now writes `baseline_mm` ALONGSIDE
the wide-camera intrinsics (the `fovea:wide-camera` singleton) when the triple
carries one. Old containers omit it → the viewer depth readout shows "—".

## Part B — viewer footprint overlay

The viewer already replays the telemetry channel per frame but DROPPED the docs
(`ViewerWindow.vue` `case "telemetry": break`). Now:

- The renderer retains the LATEST telemetry doc per stream (reset-on-seek, same
  as descriptors).
- Footprint = the stream's frame corners `(0,0)/(w,0)/(w,h)/(0,h)` mapped
  through its recorded `affine` → a quad on the WIDE/master tile (same SVG slot
  and wide-undistorted pixel space as the descriptor bboxes). `projectQuad`
  (pure, unit-tested).
- **Pair rule (color grouping):** the L/R streams of a fovea pair share one
  color. Pairs derive from CHANNEL NAMING — strip the side token
  (`left`/`right`/`l`/`r`), the remaining BASE is the pair key; a base pairs iff
  exactly one L + one R claim it. Unlike the timeline's 3D `detectPairs`, an
  EMPTY base still pairs, because multi-fovea names its two fovea streams exactly
  `left`/`right` (the sole stereo pair). `groupStreams` (pure, unit-tested).
- **Coloring:** greedy interval-coloring over each group's `[startNs,lastNs]`
  block range (overlap → distinct index, disjoint → reused), mapped into the
  existing `TARGET_COLORS` palette. `assignColors` (pure, unit-tested).
- **Toggle** "show all projections" on the preview header, DEFAULT OFF: off draws
  only the hovered/focused stream(s); on draws every stream active at the
  playhead.
- **Depth readout:** each box carries its stream id; on hover it also shows the
  pair's vergence-plane depth from the two recorded angles + the container
  baseline (`vergencePlaneDepth` → `vergenceToDistance` in `@lib/stereo`). "—"
  when baseline/partner missing, "∞" when parallel.
- **Hover unification:** hovering a box == hovering that stream's timeline block
  (one shared `hoverChannels`/`highlightChannels` set, both directions).

The toggle is session-local (not persisted to the sidecar) to keep the sidecar
schema untouched — a candidate future enhancement if users want it sticky.

## Open questions / rig pass

- The recorded `affine` is `A2H(V2A(volt))` — the exact matrix the display wrap
  applies, but whether the footprint should map through H or its inverse /
  composition into wide-frame coordinates is the SAME open direction question
  `homography-feeder.ts` already flags. Only verifiable on the rig; if it points
  the wrong way the fix is at the recorded H (shared with the live path), not
  the overlay.
- `mirrorAt` host-ns vs the frame's device timestamp are assumed to share the
  trusted host clock (ruled invariant) — confirm the interpolated footprint
  tracks the live one on the rig.
