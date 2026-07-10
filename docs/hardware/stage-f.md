# Stage-F — the living rig checklist

Items that are **code-complete but only verifiable on hardware** (live
cameras + a v2-flashed controller). Swept from RIG-GATED / RIG-VERIFY markers
across the app docs and refactor-era commit messages at round close
(2026-07-08). Check items off here as rig sessions confirm them; each line
names the mechanism it gates.

## Serial / actuation (v2 firmware)

- [ ] **predictVolts accuracy** — compare locally predicted volts against a
  sampled real `Actuate` readback; confirms the firmware ECHOES commanded
  channels (streamed telemetry correctness). `orchestrator/controller.ts`.
- [ ] **FW5 coexistence** — streamed actuation + CMD_FRAME captures together:
  no `Streams::snapshot` corruption, FIN voltages sane.
  `orchestrator/controller-node.ts` (absorbed actuation.ts) + `scheduler.ts`.
- [ ] **Serial rate** — `controller:<port>` packets/sec in the profiler at
  target (kHz-class) with the loop freed + fire-and-forget streaming.
- [ ] **FIN exposure voltage** — live FIN↔frame pairing: recorded
  `volt.source: "fin-averaged"` bound to the exact triggering frame
  (`recording.ts`); calibrate-extrinsic's v2 recorded-voltage=predicted-volt
  nuance.
- [ ] **Frame scheduler** — `scheduler.start()` pumping CMD_FRAME on live v2
  hardware (returns null / parked on v1); multi-fovea per-target imagery
  (`fovea:` tiles) once wired.

## Vision / streams

- [ ] **Worker vision parity** — all migrated apps' vision (per-session
  worker kernels) visually match the pre-migration output; fps recovery
  confirmed in the profiler (registry:* gone, converters busy).
- [ ] **Composed multi-fovea** — live multi-target tracking quality +
  composed-fovea preview (renderer-composed nodes, native multi-KCF).
- [ ] **Undistort producer calibration** — B's native remap uses the intended
  camera matrix (`mtx` via `initUndistortRectifyMap`, not an alternate) —
  manual-control residual.
- ~~**KCF arm-in-raw-space** — tracking-single~~ — RETIRED: tracking-single
  was deleted 2026-07-08 (role replaced by disparity-scope; commit 6f8097c).
  The arm-from-drag discipline now lives in disparity's chained tracker —
  covered by §"Disparity tracker → own thread".
- [ ] **Disparity-scope magnification** — see "### Match magnification fix"
  below (ruled precedence + new marker-quad measured value, 2026-07-09; the
  old `scale·1000/focal` ratio was retired).
- [ ] **Calibrate-drift derived volt** — derived drift matches physical
  reality.
- [ ] **12-bit readout A/B** — live capture in each listed 12-bit format
  (code-complete end to end; preview-safe option filtering).

## Platform

- [ ] **Freeze-gone re-check** — manage-cameras preview marathon (the old
  transfer-pool GC freeze class) on the current pipe path.
- [ ] **V12 live check** — opening the profiler mid-tracking: mirrors keep
  moving, SHM previews unaffected.
- [ ] **HIL re-baseline** — export a fresh profiler snapshot set (pre-flight
  + PB2) against the post-refactor architecture for the record.

## Hardware quiescence (safety invariant, fixes of 2026-07-08 rig finds)

- [ ] **App-switch reopen race gone** — exit manual-control → enter another
  triple app repeatedly: no `Failed to restore pixel format … access-denied`
  in the orchestrator log (registry awaits the pending close + retries the
  config apply across the acquisition-stop window).
- [ ] **No more exit-6 aborts** — the same switch marathon never ends in
  `libc++abi: terminating due to uncaught exception of type Napi::Error`
  (core now builds with `NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS`).
- [ ] **Exit-with-live-camera clean (fix 2026-07-08 late, rig find 22:40)** —
  exit the orchestrator while cameras are open (e.g. right after leaving
  disparity-scope): NO `SIGABRT`/exit-6 from `v8::HandleScope` fatal in the
  cleanup registry (`CameraObject::destruct` now opens its own HandleScope);
  the janitor/quiesce flow above still completes normally after it.
- [ ] **Graceful-quit quiesce** — quit the app with MEMS enabled + streams
  live: orchestrator log shows the drain, the device echoes `MEMS Disable`,
  and the next boot's config restore succeeds first try.
- [ ] **Crash janitor** — `kill -ABRT` (or -9) the orchestrator mid-tracking:
  main logs `[janitor] launching…`, the device echoes `MEMS Disable`,
  `[janitor] camera <serial>: acquisition stopped` for each streaming camera,
  and relaunching finds no locked camera (config writes succeed).
- [ ] **Disconnect disables** — title-bar controller disconnect while
  enabled: device echoes `MEMS Disable` before the port is released.

## Round-2 fixes (2026-07-08, commit 6bd5794) — ⚠ FLASH FIRMWARE FIRST (`cd firmware && make upload`)

- [ ] **Mirror follows streamed targets** — manual-control drag: the physical
  mirrors track the commanded position (firmware fix: CREATE auto-activates
  the DAC-driving stream; previously only CMD_FRAME captures activated one —
  mirrors stayed at origin).
- [ ] **Pipeline graph renders** — every app shows its node graph; snapshot
  export saves and the folder button reveals the file (perfSnapshot no longer
  rejects on live converter/tracker probe rows).
- [ ] **Stream update rate at input rate** — dragging in manual-control shows
  `controller:<port>` packets and the per-stream Hz well above 60 (device
  polling rate via pointerrawupdate; wire path is kHz-capable).
- [ ] **fps ceiling** — with the graph live, read the CAMERA node's output
  rate: if it's already 30, the cap is stored config (manage-cameras
  frame_rate / exposure > ~16 ms), not the pipeline; 4-buffer stream slack
  landed either way.

## Unified time (proposal P1/P2, 2026-07-08) — ⚠ FLASH v1.1 FIRMWARE FIRST

- [ ] **TimestampLatch support** — check each camera model accepts
  `TimestampLatch`/`TimestampLatchValue` (profiler Clocks panel shows
  `method: latch` per `camera:<serial>`; a missing row + "TimestampLatch
  unavailable" diagnostic = fall back decision needed). Confirm the latched
  value's UNIT (assumed ns).
- [ ] **Controller ping** — with v1.1 flashed: Clocks panel shows
  `controller` row, jitter well under 500 µs; `readTimestamp` on OLD
  firmware times out gracefully (3 s) instead of wedging connect.
- [ ] **Offset sanity** — camera and controller offsets stable across
  reconnects (± jitter); re-calibration after sleep/wake.
- [ ] **Mirror history** — during streamed actuation, `mirrorAt` age stays
  ~1 tick (no gaps) — observable once the fovea homography consumes it.

## Unified-time FINAL + brick chain (2026-07-08 close, through 77d4afb) — ⚠ FLASH v1.1 FIRST

- [ ] **Owner-thread calibration live** — profiler Clocks section fills
  within seconds of camera open (method latch, jitter ~50–150 µs matches the
  bench smoke) and driftPpm appears after the first 30 s drift re-run;
  re-calibration updates rows mid-task. TimestampLatchValue ns assumption
  per model (RIG-CHECK in ClockCalibration.cpp).
- [ ] **Trusted-time end-to-end** — recorded/paired timestamps (camera
  frames vs FIN tTrigger/tExposure, now both host-ns) agree to ~ms; sync.ts
  deltas collapse to trigger-path latency.
- [ ] **Chained bricks visual parity** — center undistort (now chained on
  the shared converter) matches the old fused output; fovea crops on the
  undistort chain; graph shows camera → convert → undistort → fovea with
  real edges + tx/rx/drop labels.
- [ ] **L/R homography orientation** — the OPEN QUESTION in
  homography-feeder.ts: conv.A2H H vs its inverse/wide-frame composition;
  wrong guess = harmless warp, passthrough meter names it. Verify + fix the
  seam in one place.
- [ ] **Enable no longer resets MCU clock** — calibration survives
  enable/disable cycles (v1.1 behavior change).

## PID nodes + view re-plumb (2026-07-08 wave, through 9217523)

- [ ] **View fps decoupled** — disparity-scope /
  manual-control / calibrate-distortion (tracking-single deleted 2026-07-08):
  L/R (and disparity's C) main views
  render at CAMERA rate while the kernel meters lower (the 36–40 vs 60 fps
  gap closes); profiler graph shows the undistort nodes in every chain.
- [ ] **Disparity chain renders** — camera→convert→undistort→scope→pid→
  controller in the graph; scope node meters only analysis work (no view
  relay traffic on its edges).
- [ ] **Undistorted-view alignment** — disparity's overlays (target dot,
  pose rects, tracker bbox, match rects) align on the undistorted C view;
  L/R undistorted views track mirror pose via the feeder (no wrap toggle
  anywhere anymore). RIG-CHECK (pre-existing): feeder H vs inverse — one
  seam in homography-feeder.ts.
- [ ] **Zoom-scaled pose markers** (2026-07-08 fix) — the per-eye L/R pose
  rects on the C view now draw at the fovea FOOTPRINT (`size / zoom`,
  app-config zoom), framing exactly the sliced center tile, NOT the whole
  wide frame. Confirm they shrink/grow with the Zoom Ratio knob and sit over
  the magnified fovea footprint.
- [ ] **Guide strip == sliced center tile** (2026-07-08 fix) — the Template
  Match Guide strip is the center tile (`width/zoom × height/zoom`) expanded
  by X/Y Expansion; its translucent center marker overlaps the sliced center
  view's crop. On a calibrated rig (match magnification ≠ nominal zoom)
  confirm the strip tracks the NOMINAL zoom, and the fovea match still locks
  (tile scale unchanged).
- [ ] **Override semantics live** — SUPERSEDED for disparity drags by the
  §3.5 tracker-override flow (see the next section): the disparity drag no
  longer pins the PID at all. Still verify the PID-slot path where it
  remains live: calibrate-drift / calibrate-extrinsic per-eye drags —
  dragged eye pins (controllers held reset), other eye keeps servoing;
  release resumes from the released pose. Disparity's generic `pidOverride`
  command (programmatic volts) still seeds on release via the V2A
  reconstruction inverse.
- [ ] **Servo numeric parity** — calibrate-drift/extrinsic marker servoing
  converges exactly as before (PID2D velocity form is bit-identical on the
  bench; confirm no felt difference on hardware).
- [ ] **Capture wrap default** — manual-control captures always save
  WRAPPED foveae now (the retired toggle's default); confirm downstream
  consumers of recorded captures expect this.

## Disparity tracker → own thread (§3.5, 2026-07-08 D2 wave)

- [ ] **Tracker off the matching thread** — with auto-follow ON, the
  disparity kernel node's meter no longer includes KCF work; a new
  `camera/<serialC>/undistort/kcf` node renders in the graph (edges
  C-undistort → kcf → disparity kernel) with its own utilization/rate
  badge. Kernel throughput should HOLD or improve while tracking (the KCF
  budget left the loop).
- [ ] **Tracker tracks what the matcher sees** — the kcf node chains on the
  C UNDISTORT brick: the tracker bbox overlay stays aligned with the
  undistorted C view (no distortion offset near the edges).
- [ ] **§3.5 drag semantics (AMENDED 2026-07-08/09: direct parallel follow)**
  — dragging on the C view: the override badge lights (telemetry
  `overridden` — tracker flag, NOT the PID slot), the sliced view + guide
  strip follow the pointer, and BOTH FOVEAS TRACK THE RAW CURSOR RAY IN
  PARALLEL — vergence at infinity, pan/v_shift/verge all RESET at
  pointer-down (no PID stepping, no match gate; the earlier "PID servos
  toward the tile" semantics deadlocked on low score and the foveas never
  moved — rig find 2026-07-08 22:40). EXPECT a visible snap at drag start
  when corrections had accumulated (the reset is intended). Works over
  unmatchable content (blank wall) too; the depth readout shows ∞ while
  dragging. Status reads "manual"; a long drag never hits the convergence
  timeout. Drag should feel snappy (follow rides pointer/frame rate, not
  kernel rate).
- [ ] **Release re-arms, no jump** — on release with auto-follow ON, the
  tracker re-arms at the drag end and keeps following; with auto-follow
  OFF the target stays put (results gated JS-side; native thread keeps
  running — known cost, no native disarm). Either way the mirrors continue
  from their in-flight PARALLEL pose (all controllers reset at drag start,
  so state == command: the first resumed PID output equals the last follow
  output) — no discontinuity class on this path; every DOF then
  re-converges from scratch onto the release point.
- [ ] **Lost policy parity** — auto-follow losing the target for ~10
  consecutive frames drops the gate (status returns to armed-off behavior,
  target holds last-good) — same UX as the old in-kernel tolerance.
- [ ] **Teardown ordering** — closing the app/session with the tracker live
  leaves no orphan brick/tap: the undistort brick retires cleanly after the
  tracker releases (watch for brick-leak warnings in the orchestrator log);
  reopening the app immediately works (no reopen race).

## Controller node + FIFO edges (2026-07-08 wave close, through c3132f5)

- [ ] **FIFO backpressure live** — under real camera load the undistort
  node's input edge shows `queue hwm/cap` in the graph hover (no drop rate);
  zero undistort drops while the converter's camera edge absorbs overload;
  the edge warn marker fires only if hwm actually reaches capacity.
- [ ] **Controller node live** — connect the controller: the `controller`
  graph node folds the `controller:<port>` packets/sec meter; each active
  app draws its position edge (pid → controller for disparity; detect →
  controller for calibrate-distortion); edges retire on app close.
- [ ] **Push-model actuation parity** — disparity volt telemetry now rides
  the kernel result rate (verify the readout feels live); calibrate-
  distortion mirror-following at detection rate (gate dedupe means wire
  traffic equal or lower than the old 1 ms loop); marker servo + manual-
  control unchanged in feel.
- ~~**Trigger-mode pairing e2e** — `onPair` emits L/R descriptor pairs
  matched by tExposure within tolerance~~ — SUPERSEDED: the in-JS `onPair`
  matcher was deleted when pairing moved into the native PairStream brick
  (pairing-nodes ruling 6). Live checks — including the round-robin
  `startTriggerCapture` path and tolerance tuning — are §"Pairing nodes"
  below.
- [ ] **Cmd/Ctrl-W** — closes each window class with the expected rules
  (app close respawns welcome; profiler/projection just close).
- [ ] **Launcher regroup** — welcome shows Applications / Calibration /
  Utilities; calibration titles read Intrinsic / Extrinsic / Distortion /
  Drift; tracking-single is gone everywhere (menu, Apps menu, restore of an
  old layout referencing it degrades silently).

## Split disparity nodes (2026-07-09 wave, through f1be670)

- [ ] **Node graph shows the split** — with disparity-scope live, the graph
  renders `slice/scope-strip` + `slice/scope-tile` (fovea-brick rows),
  `scope-strip/scale/match` + two `scale/scope-needle` rows (kind "scale",
  scale ← source edges from Topology self-report), `match/L` + `match/R`
  worker nodes with individual meters, and the pid node with l/r/target
  input edges. No orphan `win/disparity-scope/disparity` row remains.
- [ ] **Match parity** — per-side match rects/scores on the guide strip look
  equivalent to the pre-split matcher on the same scene; `min_score` gating
  and convergence behave as before. Join rate ≈ strip frame rate (the two
  workers run concurrently; the pair-completion join steps ~once per strip
  frame and degrades to the slower side, not the sum).
- [ ] **Live steering** — dragging/zooming re-steers the strip + tile crops
  next-frame (sliced view + guide strip follow with no re-advertise churn);
  changing Template Scale retunes the scalers live; extreme zoom/expansion
  combos clamp (native ring guard) rather than crash.
- [ ] **Views at pipe rate** — sliced center view + guide strip render at
  their slice pipes' rate; the composite center tile (anaglyph | difference —
  replaced the old DiffView canvas in the composite-node wave) renders at its
  pipe's rate; match heatmaps still arrive as session frames.
- [ ] **Scale brick health** — `scaleProbeAll` rows show sane rate/util; the
  strip scaler's upsample cost is visible per node (was hidden inside the
  monolithic kernel's budget).
- [ ] **Teardown** — exiting the app retires scalers → slices → undistort
  bricks cleanly (no brick-leak warnings, no reopen race on immediate
  re-entry); reopening works first try.

## Center-view restore + stereo SGBM/heatmap nodes (2026-07-09 wave)

- [ ] **"No Frame" fixed (9e15592)** — the sliced center view, the guide
  strip, AND the multi-fovea preview tiles all render real pixels now (every
  C-20 variable-size pipe read was rejected renderer-side before this fix —
  multi-fovea previews had never actually rendered on the rig).
- [ ] **Controller edge rate (b1ba49d)** — with the PID engaged, the
  pid → controller edge in the profiler graph shows the real position push
  rate (≈ strip frame rate), not 0Hz; match → pid edges show rx rates.
- [ ] **Anaglyph view** — red = LEFT eye, cyan = RIGHT (swap check: cover
  the left fovea camera → the red channel goes dark).
- [ ] **SGBM view** — selecting "SGBM Disparity" starts the stereo + heatmap
  bricks (graph gains `stereo/scope` + `stereo/scope/heatmap/view` rows with
  live meters); a static textured scene shows a plausible depth-ordered
  TURBO heatmap; near objects hotter than far ones once verged.
- [ ] **On-demand park/resume** — deselecting the SGBM view parks BOTH
  bricks (their meter rates fall to 0 within a second; orchestrator CPU
  returns to baseline); reselecting resumes within a frame or two. Same
  check for the sliced view's scope-tile pipe (selected ⇄ parked).
- [ ] **Teardown** — exiting the app retires heatmap → stereo → undistort
  cleanly (no brick-leak warnings; immediate re-entry works first try).

## Disparity debugger window (2026-07-09 wave, fc9ac30)

- [ ] **Toggle** — the "Debugger" button (bottom of the center column) opens
  the debugger window; pressing it again closes it; opening it does NOT
  drain/switch the app (exclusivity exemption).
- [ ] **Cascade** — closing the disparity-scope window (or switching apps)
  closes the debugger with it.
- [ ] **Column alignment** — a feature at strip column x shows its score
  peak at the same display column in the Left/Right match rows (the padded
  heatmaps line up with the strip; check near BOTH edges too — the zero
  border is the neutral mid color, not a shifted copy).
- [ ] **No projection/fullscreen button** on the three debug views
  (`:projectable="false"` — the old button misbehaved as element-fullscreen).
- [ ] **Main UI** — the inline strip + match views are gone; layout below
  the cameras is clean with the drawer open and closed.

## Composite node + center select (2026-07-09 wave, 59ad332)

- [ ] **Center dropdown visible** — the view select shows on ALL four center
  views including the default sliced one (it was silently dropped before —
  StreamView never forwarded the #title slot), and switches live.
- [ ] **Composite node in the graph** — `stereo/composite` appears in the
  profiler with left/right input edges; meters run ONLY while the
  disparity or anaglyph view is selected (parked otherwise, rate → 0).
- [ ] **Anaglyph parity** — red = LEFT eye, cyan = RIGHT (cover the left
  fovea camera → red goes dark). disparity ↔ anaglyph flip retunes the same
  connected pipe without a frame gap or reconnect flicker.
- [ ] **Renderer load drop** — the old DiffView canvas composite is gone;
  with anaglyph selected, renderer CPU/GPU should be LOWER than the previous
  build under the same scene (Graphite-relevant: fewer per-frame
  putImageData/composite passes).

### Anaglyph style (2026-07-09 user ruling — R/B, R/C, B/R, B/C cards)

The Anaglyph left/right colors are now the app-config `anaglyph_style`
(default RC), surfaced as four selectable cards in **Settings → Application**
and shared across the disparity-scope center view + the recording viewer's 3D
mode via the `docs/schema/anaglyph` mapping table (native `CompositeStream`
mirrors it; core test 27 pins RC + BR).

- [ ] **Four cards render truthfully** — Settings shows R/B, R/C, B/R, B/C as
  split swatches (left half = left-eye color, right half = right-eye color,
  with L/R glyphs); the selected card carries the accent outline and
  selecting another does NOT shift the layout.
- [ ] **Center view follows each style** — with a red/blue test object, for
  each style the red content appears in the eye the card names (e.g. under
  **B/R** the red object drives the RIGHT eye, blue the LEFT); the option
  label updates to match (e.g. "Anaglyph (Blue = Left, Red = Right)").
- [ ] **B/C shared-blue truth** — under **B/C** the left (blue) eye owns the
  blue channel and the right (cyan) eye shows only green — matches the card
  swatch (flagged oddity: verify this is the intended arrangement, else the
  user meant C/R).
- [ ] **Live retune, no reconnect** — changing the style in Settings while the
  Anaglyph view is up retunes the `stereo/composite` brick on the next frame
  (no pipe reconnect, no frame gap, meters keep flowing).
- [ ] **Viewer playback matches** — open a stereo recording, set 3D = anaglyph;
  each style composes the same left/right colors as the live scope view.

## Needle sizing fix (2026-07-09, user rig find "needles way too small", 2 rounds)

Round 1 (8bdd5b6) paired the tile dims with the zoom source; round 2 (the
real defect, user-diagnosed "9x applied twice / 81x"): the needle scalers
sourced the HOMOGRAPHY-undistort pipes — whose warp already lands the fovea
at wide density — and then divided by the magnification again. Needles now
source the RAW fovea CONVERT pipes (single ÷magnification, legacy
`getFoveaTile` semantics); stereo/composite keep the warped pipes.

- [ ] **Needle footprint** — with a calibrated triple, the L/R match rects
  on the debugger's guide strip are fovea-FOOTPRINT sized (≈
  `foveaWidth/matchZoom` wide-px — NOT a ~1/9 sub-tile); match scores
  recover accordingly.
- [ ] **Raw-vs-rectified tolerance** — the needle is now the RAW
  (un-rectified) fovea against the intrinsic-undistorted strip, as legacy
  tolerated; watch for score degradation from the perspective difference
  over the narrow fovea FOV (the loop absorbs constant offsets).
- [ ] **Nominal fallback unchanged** — with calibration cleared (no measured
  magnification), needle sizing matches the legacy `W_c/zoom` behavior.
- [ ] **Stereo/composite unaffected** — SGBM + anaglyph/difference center
  views still consume the warped pipes (wide-registered imagery).

### Match magnification fix (2026-07-09, ruled precedence + new measured value)

The `scale·1000/focal` measured magnification was RETIRED (it assumed the
marker sat 1000 side-lengths away — false on the rig, inflating it ~16×).
Explicit `state.zoom > 0` is now authoritative; `zoom=0` is "Auto" → a new
distance/size-free marker-quad-ratio magnification (wide camera's view of the
side markers, else the center-marker fallback with recorded marker sizes).

- [ ] **Zoom=9 needle size** — with `Zoom Ratio = 9`, the `[size-trace]`
  console output shows the needle `dsize` ≈ **160×120** (not ~10×7); match
  scores are healthy.
- [ ] **Auto (zoom=0) measured value** — with a FRESH extrinsic calibration
  (captures where the wide camera sees the side markers) and `Zoom Ratio = 0`,
  the "Zoom Ratio" input shows **Auto N×** and `match_magnification` telemetry
  reads ≈ **9** (sanity vs the known optics), not ~145.
- [ ] **Legacy calibration + zoom=0** — an OLD extrinsic dataset (no wide-
  camera marker quads) with `Zoom Ratio = 0` falls back to **1×** (degenerate
  but honest — full-frame match); setting a nominal zoom restores a usable
  match. No crash, no NaN.

### Per-triplet settings (2026-07-09 wave — baseline per-triple + zoom_override wiring)

The stereo **baseline** became a per-TRIPLE setting (`baseline_mm` in the
`["triples", <hash>]` doc; the app-level `baseline_distance_mm` is now a legacy
fallback only), and the previously stored-only `zoom_override` was wired into
Disparity Scope's match-zoom resolution (knob > override > measured > 1). Both
resolve at **session activate**; baseline marker spacing is **live** in the
calibrate windows.

- [ ] **Baseline → extrinsic marker spacing (live)** — in **Settings →
  Calibration data**, expand the connected rig's triple and set **Baseline** to a
  value clearly different from 200 (e.g. 120). With **Calibrate Extrinsic** open,
  the L/R target markers on the TeleCanvas re-space **immediately** (no restart);
  editing the field back to empty snaps them to the app-default spacing.
- [ ] **Baseline → drift + distortion marker spacing (live)** — the same live
  re-spacing holds in **Calibrate Drift** and **Calibrate Distortion** for that
  triple.
- [ ] **Empty per-triple baseline falls back to legacy** — a triple with the
  **Baseline** field empty shows *app default: 200 mm* and places markers at the
  200 mm spacing; no triple in the store behaves any differently than before this
  wave (zero-migration).
- [ ] **Baseline → Disparity Scope verge limits (next session)** — set a triple
  **Baseline**, then start **Disparity Scope**: the Verge slider's max reflects
  the new baseline (via `distanceToVerge(150, baseline)`); the realized/commanded
  depth readouts are consistent with that baseline. A mid-session Settings edit
  does NOT change the running verge limit (activate-time read — honest).
- [ ] **zoom_override drives Auto match zoom (next start)** — set a triple's
  **Zoom override** (e.g. 7), leave the window **Zoom Ratio = 0**, start
  Disparity Scope: the Zoom-Ratio readout shows **Auto 7× (triple override)** and
  the needle `[size-trace]` dsize reflects 7× (not the measured value).
- [ ] **Knob still wins when > 0** — with a triple override set, typing a
  **Zoom Ratio > 0** in the window immediately overrides it (the readout stops
  showing "(triple override)" and the match uses the knob value).

## Capture/recorder nodes (2026-07-09/10 waves, 388454f→bee815c)

> **Rig findings 2026-07-09 (user)** — three items below FAILED on the live
> rig; fixes are planned, re-verify after they land:
> capture preview waits forever / Save disabled (F1) and recording drops
> many frames (F2) → `docs/proposals/capture-recorder-everywhere.md`;
> viewer BayerRG12p striped decode (F3) →
> `docs/proposals/standalone-viewer-and-fcap.md`.

- [ ] **Recorder zero-loss on real cameras** — record L/C/R for ≥ 60 s at
  full rate: recorder/<session> graph row shows ingest ≈ camera rate,
  drops ≈ 0, `written + drops == published` per channel; orchestrator
  main-loop utilization FLAT while recording (the point of the wave).
- [ ] **Auto-open** — stopping a recording opens the viewer window on the
  finished `.fovea`; playback seeks from 0; telemetry extras present on
  L/R frames (live-snapshot provenance until FIN pairing lands).
- [ ] **Capture full-depth parity** — same resources as a pre-wave capture
  (wide/fovea/center/left/right/diff), byte-identical saved output on live
  sensor formats; `significantBits` of the raw-pipe container matches
  `frame.raw_format`.
- [ ] **Raster capture** — N set-points → N indexed resources with per-shot
  metadata snapshots; preview window opens (and re-focuses, never toggles
  shut) after each run; abort (Esc / second click) discards + retires the
  raw pipes.
- [ ] **Exclusivity live-race** — capture button mid-recording → typed
  refusal; Cmd-R mid-raster → startRecording returns false; no clobbered
  recording, no wedge, recording file intact.
- [ ] **Cmd-R** — toggles recording start/stop in manual-control; no-op in
  other apps.
- [ ] **Finalize deadline** — a legitimately large container finalizes well
  inside 30 s (the force-terminate path should never fire on healthy disk).
- [ ] **Raw pipes park** — with no recording/capture active, the
  camera/<serial>/raw rows show zero rate (capture: no producer at all).

## Multi-fovea recording (2026-07-09 waves, 9be0c07→I-2; proposal
`multi-fovea-recording.md` r2.1)

- [ ] **12p payload verbatim** — record a raw12p stream on a live camera in
  12p readout; per-frame payload byte length == W·H·3/2, and `unpack12p`'s
  output matches a reference wire capture bit-exactly (the fake camera only
  proved Mono8 plumbing; GenICam 12p bit order is unit-vector-verified
  ONLY).
- [ ] **Zero-loss raw12p recording** — L/C/R raw12p at full sensor rate ≥
  60 s: recorder stats ingested == written, 0 drops, flat main-loop util
  (the ~4.7 MiB/frame packed payloads are the heaviest recording load yet).
- [ ] **Per-stream /zlib live** — one stream routed through CompressStream:
  bench-measured ~26 MB/s (default) / ~55 MB/s (level 1) says a wide 12p
  stream WILL drop-account at full rate — verify drops are metered +
  visible, fovea-crop-sized streams hold, real Bayer data ratio recorded
  for the codec-choice follow-up.
- [ ] **Descriptor↔frame pairing live** — under round-robin trigger, each
  target's descriptors point at the L/R raw12p seqs whose frames were
  actually aimed at that target (spot-check by reconstructing crops
  offline); center pointer = nearest free-run (explicitly unsynchronized).
- [ ] **Free-run descriptor shape** — recording without trigger mode:
  descriptors carry bbox + center + null L/R, container decodes cleanly.
- [ ] **Extras binding** — per-fovea-frame `{volts, V2A, H}` extras match
  the FIN anchor that triggered the frame. The L/R extras are sourced from
  the pairing anchor (a real FIN outcome, trigger mode only) and labelled
  `volt.source: "fin-averaged"` — the FIN-sourced provenance token, matching
  the capture-recorder convention. NOTE the value is only truly exposure-
  averaged once v2 firmware lands (FIN currently reports its initial reading —
  the `fin-exposure-voltage` item); the label denotes the SOURCE, not the
  averaging algorithm. Free-run frames get no anchor → NO extras (not a
  live-snapshot: multi-fovea extras ride pairing, which is trigger-only).
- [ ] **Record button + Cmd-R (multi-fovea drawer)** — the title-bar
  RecordButton starts/stops on a rig; plain Cmd/Ctrl-R toggles the FOCUSED
  window only (per-window `before-input-event`), so a second app window (or
  manual-control) open at once does NOT double-toggle; hover stats show the
  three raw12p streams.
- [ ] **PAIR_FRESH_MS tuning (1 s default)** — under live round-robin
  trigger, confirm each target's controller stream is revisited faster than
  the 1 s freshness window so descriptor L/R pointers bind to the CURRENT
  round's pair (a stale pair past the window degrades to null L/R); tune the
  constant if the target count × dwell exceeds it. (Cross-ref the
  observation-driven-vs-pair-driven descriptor-emission follow-on ruling —
  a descriptor emitted just before its pair arrives binds to the previous
  round's pair or null; acceptable for offline reconstruction today.)
- [ ] **Wide camera matrix singleton** — `fovea:wide-camera` metadata
  matches the calibration triple's center intrinsics.
- [ ] **Viewer playback of a rig container** — 12p unpack + debayer display
  looks right (colors — Bayer order!), /zlib stream plays, bbox overlay
  tracks the recorded target, channels appearing mid-file (target armed
  mid-recording) seek cleanly; auto-open on finish.
- [ ] **Raw12p pipes park** — no recording active → raw12p rows at zero
  rate and the refcounted registry releases producers (probe shows no
  attached taps).

### Recording compression setting (2026-07-10, `record_compression` app setting)

> App-level `record_compression: "none" | "zlib"` (default `"none"`), Settings →
> Application. Read at RECORDING START via store-hub. `"none"` = today's raw
> streams for every app. `"zlib"` = the generic recording facility
> (`@orchestrator/raw-recording`: disparity-scope + the four calibrate wizards)
> routes ALL its raw streams through the per-frame /zlib CompressStream brick;
> multi-fovea keeps its own composition and its per-stream toggles gate WHICH
> streams use the method. **Behavior change:** multi-fovea's per-stream toggles
> were previously hardwired to zlib — they are now ENABLES of the configured
> method and are DISABLED under `"none"`. (Manual-control uses its own recording
> controller and is NOT wired to this setting — see the split-of-work note.)

- [ ] **zlib generic recording sustains or drops honestly** — with
  `record_compression = "zlib"`, record disparity-scope (and each calibrate
  wizard) for ≥ 60 s: every stream is written through its `camera/<serial>/raw/zlib`
  sibling (recorder rows show the `/zlib` pipe ids), and the drop attribution
  (record-button hover `q…/r…`) is honest if the codec can't hold full rate.
- [ ] **`"none"` is byte-for-byte today's behavior** — with the default, every
  app records exactly the raw uncompressed streams it did before (no `/zlib`
  pipe advertised); multi-fovea's per-stream checkboxes are DISABLED with the
  "compression off — enable in Settings" hint and nothing compresses even if a
  box was left checked before switching to `"none"`.
- [ ] **Multi-fovea toggles gate the configured method** — under `"zlib"`, only
  the checked streams route through `/zlib`; unchecked streams stay raw.
- [ ] **Old + new recordings both decode** — a `"none"` recording, a `"zlib"`
  recording, and a pre-setting recording all open in the Viewer/pyfcap
  identically (the `/zlib` suffix drives decode; on-disk contract unchanged).
- [ ] **Applies at start, not mid-recording** — changing the setting while a
  recording runs does NOT change that recording; the next recording picks it up.

## Pairing nodes (2026-07-09 wave, 426eb05 + ac6ee85; proposal
`pairing-nodes.md`)

- [ ] **Root match rate** — live round-robin trigger: matched-pair rate ≈
  FIN rate, unmatched-FIN counter near zero at the ruled tolerance (half
  min frame interval); tune the 8 ms default if the trigger-path latency
  spread demands it (record the measured per-side deltas from
  `calibrate()`).
- [ ] **Downstream exact chain** — with undistort live, the undistort-stage
  pair emits at the root rate with per-side keys matching (resolved-anchor
  forwarding at FIN rate; zero tolerance misses by construction).
- [ ] **Anchor payload physical sanity** — V2A angles vs commanded mirror
  position; H maps the fovea into the wide frame within calibration error.
- [ ] **Always-on pool behavior** — pairing bricks idle in free-run (empty
  pool, zero output, near-zero util); under live churn (trigger start/stop,
  camera re-lease) pool drop counters stay bounded and no thread leaks
  across session restarts.
- [ ] **Trigger-line names** — the GenICam trigger input/strobe names in
  sync.ts are UNVERIFIED placeholders; confirm against the real camera
  model before any of the above.

## Stereo paired inputs (2026-07-09, 5537745; proposal
`stereo-paired-inputs.md`)

- [ ] **Epoch-mixing gone under motion** — with trigger pairing live, the
  paired-SGBM view (`stereo/paired` over `pair/undistort`) shows no
  disparity smearing on a laterally moving target where the latest-wins
  view does (the migration's point); output rate ≈ pair rate ≈ FIN rate.
- [ ] **pairDrops under load** — `stereoProbeAll` shows `paired: true` and
  `pairDrops` staying near zero when SGBM keeps up; artificially slow SGBM
  (large numDisparities) sheds OLDEST records with the meter counting —
  the pairing pipeline (anchor forwarding, undistort backpressure) is
  unaffected while it sheds.
- [ ] **Live mode flip** — once hardware trigger wiring drives
  `startTriggerCapture` from a session: trigger start recomposes the
  disparity view onto the paired node and stop returns it to latest-wins,
  seamlessly (no re-advertise flicker — same Disparity32F advert). Until
  then the paired node rides the multi-fovea pairing topology only.
- [ ] **Park/resume** — deselecting the paired disparity view parks the
  brick (record tap unsubscribed; pair brick keep-alive unaffected —
  its pool keeps churning); reselect resumes within a pair or two.

## Iteration 2026-07-09 (F1/F2/F3 fixes + 8 programs, 362b69f→wave close)

### F1/F2/F3 re-verify (the rig findings that started this round)
- [ ] **F1 capture** — capture completes on the rig; if a port still
  stalls, the run now REJECTS at 10 s naming it ("center delivered 0/5…")
  with progress notices before that; app never wedges. If the hang
  persists against these fixes, the remaining suspect is camera/
  `Arv::Stream` exclusivity re-open across RECORDING→CAPTURE (core pipe
  gate exonerated by test 35).
- [ ] **F2 drops** — record L/C/R ≥60 s; RecordButton hover now splits
  drops `qN` (queue overflow → encode/write chain) vs `rN` (ring lapped →
  reader too slow); capture the breakdown for the tuning ruling.
- [ ] **F3 Bayer12p** — the previously striped BayerRG12p recording
  demosaics clean in the viewer (play + paused scrub).

### Calibration polish (b62abe9)
- [ ] Checker: projected checkerboard visible on the projection window,
  pattern-size-mm slider scales it, live solve produces finite RMS shown
  in picker + post-solve.
- [ ] Drift: Update buttons disabled while a fovea tracker is unlocked or
  Δ below the 0.03° floor; derived shows null when unlocked.
- [ ] Intrinsic: record thumbnails render; marker scale slider affects
  detection rate footnote ("Detector @ N Hz").

### Spin-up progress monitor (36997f7 + 3386d12)
- [ ] Opening each app shows the step overlay (dimmed ⏳ → spinner →
  green ✓), clears on ready; a failed activation freezes the list at the
  dying step with the error shown; hover × reveals the partial app.

### Recording/capture everywhere (09695bb + 0100bf7 + 6ce3332)
- [ ] Record button + Cmd/Ctrl-R work in disparity-scope + all 4
  calibrate apps (raw streams; intrinsic = selected camera); files play
  in the viewer.
- [ ] Capture (camera icon → preview window → Save) works in the 6
  triple-holder apps (degraded shots declare wrap:none) and
  calibrate-intrinsic (single-stream); exclusivity refusals hold both
  ways vs recording.

### Standalone viewer + timeline (d28cd7a + 9efc6bf)
- [ ] Record→stop auto-opens the `.fcap`; Cmd-O filter fcap+fovea;
  legacy `.fovea` opens; dedupe focuses.
- [ ] Viewer works with the ORCHESTRATOR DOWN and keeps playing across
  app switches / orchestrator crash.
- [ ] Timeline: master wide track detected; drag block → other/new track
  (snap, persists, overlap refused); divider drag + drawer collapse;
  focus + `v` disables; 3D dropdown per pair (anaglyph colors correct —
  red=L); tile width persists; placeholder tiles (no reflow).
- [ ] Sidecar: layout/disabled/3D/split/width/playhead survive reopen;
  deleted ui.json re-inits silently; corrupt/mismatched PROMPTS before
  overwrite; Reset UI state re-packs; `.fcap` file itself untouched
  (mtime stable).
- [ ] Subtitle compact path + tooltip; Open-folder button reveals file;
  window close releases the handle (file deletable).
- [ ] Dev restart restores viewer windows onto their files.

### Lifecycle (60793fb)
- [ ] `kill -9 <orchestrator>` mid-actuation → mirrors parked, cameras
  released, crash banner (code N) in the app + its debug windows; Reopen
  reconnects.
- [ ] `kill -9 <main>` → the detached watchdog quiesces (MEMS off —
  verify on serial); exactly ONE watchdog per instance (`ps`); watchdog
  exits after clean quit. ALSO verify core loads under
  ELECTRON_RUN_AS_NODE (the one unexercised assumption).
- [ ] darwin last-window-close parks hardware (not Cmd-Q); dock
  re-activate re-arms.
- [ ] Graceful Cmd-Q: windows close first (cascade), quiesced ack →
  clean, no janitor, no banner, no orphan processes.
- [ ] Wedged quiesce on quit → bounded kill → janitor → "killed" report.
- [ ] Cmd-Shift-R dev restart: janitor fallback fires if quiesce wedges;
  no duplicate watchdogs.

### Design foundation (7d7531c)
- [ ] Visual parity spot-check under rig lighting (deliberate changes:
  error surfaces brighter/instant, action-green now #4caf50); error
  banner instantly visible, no layout shift; ProgressMonitor × visible
  dim at rest.

### Stream close deadlock fix (ee6fc46) + viewer engine (51cda07)
- [ ] Open/close disparity-scope repeatedly (≥10 cycles, tracker armed,
  views live) — no freeze, no runaway CPU on the orchestrator helper, no
  `dropped stale queued frame` flood after close (pre-fix signature).
- [ ] App-switch away from disparity-scope mid-tracking (drain path) —
  same checks.
- [ ] Viewer: Cmd/Ctrl-O opens and PLAYS a .fcap (was: hard error at
  preload-viewer.cjs:53); scrub/rate/pause work.
- [ ] Viewer sidecar: rearrange tracks, close window, reopen — layout
  persisted (flush-before-kill grace path).
- [ ] Viewer same-file dedupe still focuses the existing window; dev
  full-reload doesn't duplicate engines or corrupt ui.json.
- [ ] Viewer survives orchestrator kill/restart mid-playback.

### Teardown hardening (2026-07-10, proposal `teardown-hardening.md`)
Follow-up to the 2026-07-09 exit-6 abort (`mutex lock failed: Invalid argument`
during a dev-watch SIGTERM of a long-running disparity-scope orchestrator).
- [ ] **Long-run disparity-scope + hard kill mid-session** — leave disparity-scope
  running with tracker + stereo/heatmap/composite views live for several minutes,
  then hard-kill the app mid-session (dev-watch restart / `kill` the orchestrator).
  The orchestrator exits WITHOUT an abort, OR — if it does die on a native fault —
  prints a `=== FoveaCam native crash handler ===` banner + symbolicatable
  backtrace to the orchestrator log first. Either way it does NOT hang.
- [ ] **Janitor still parks hardware on that kill** — after the above, cameras +
  MEMS are parked (next app opens clean, no USB3Vision access-denied; MEMS
  disabled). Exit-code semantics preserved: the crash handler re-raises, so exit 6
  still triggers the janitor.
- [ ] **Repeated open/close of every brick-heavy module** (disparity-scope,
  multi-fovea, stereo) ≥20 cycles — no `Stream … destroyed without calling
  shutdown()` abort, no destroyed-mutex EINVAL, no teardown hang (the lost-wakeup
  path: a stream parks exactly as its owner tears down).
- [ ] **Guard tests on the rig machine** — `core/test/36-stream-close-deadlock.ts`
  (churn completes; the ClockCalibrator/fake-camera flake is enumeration-only, see
  proposal Audit) and `core/test/38-stream-teardown-race.ts` (30k teardown
  iterations clean) both pass.
- [ ] **Crash handler smoke** — confirm the orchestrator log shows the crash
  banner + `atos`-symbolicatable module base on a deliberately induced native
  fault (or during any real fault seen on the rig).

### Disposable orchestrator (per-app-instance lifecycle, 2026-07-09 wave)

- [ ] **App open/close/switch cycling** (≥10 cycles across manual-control ↔
  disparity-scope ↔ multi-fovea): each open acquires L/R + MEMS, each
  close/switch releases them; Welcome always comes back; cameras never end up
  held by a dead process (next app opens clean, no USB3Vision access-denied).
- [ ] **Spawn latency reading**: note the per-instance `boot.*` spans (perf
  snapshot / profiler) for a hardware app — fork → first-useful-work → first
  frame. Confirm the new app's core load/graph build overlaps the old instance's
  teardown (spin-up is NOT serialized behind the full quiesce).
- [ ] **Hardware-clear gate**: on a switch, the new app briefly shows the
  **"waiting for previous session to release hardware…"** progress step, then
  acquires once the previous instance is dead + swept. No double-lease, no black
  stream, no access-denied.
- [ ] **INDUCED teardown wedge → Welcome stays responsive**: force a teardown
  error in the outgoing app (e.g. a wedged stream close / hung quiesce), then
  open another app. The wedged process is killed at the ~4s bound + janitor
  sweeps; the Welcome window and the next app both stay fully responsive (the
  whole point of process disposal — the shared-orchestrator wedge is gone).
- [ ] **Crash mid-actuation** (SIGKILL/SIGABRT the app's orchestrator while the
  MEMS is steering): mirrors PARK (janitor disarms), cameras released, the crash
  report shows in THAT app window only (a second app window, if any, is
  unaffected), and Welcome remains usable.
- [ ] **Quit paths**: Cmd-Q / last-window (Win/Linux) with an app live — every
  instance drains + acks (or is killed + swept), probe killed, watchdog stands
  down, no orphan orchestrator/probe/janitor processes, hardware disarmed.
- [ ] **Main hard-crash** (SIGKILL main with an app live): the detached watchdog
  waits for the orphaned instance(s) to be reaped, then disarms MEMS + cameras
  (state file now carries the live-pid SET).
- [ ] **Probe survives app churn**: Welcome's camera list + status update live
  from the enumerate-only probe; the probe pauses while a hardware app is open
  (no `Camera.list()` contention with the app) and resumes at Welcome; killing
  the probe process mid-session → main respawns it and the list recovers.
- [ ] **darwin no-park**: close the app window, then close Welcome (app goes
  headless with menu bar) — nothing energized (no instance exists), only the
  probe running; dock re-activate brings Welcome back and opening an app starts a
  fresh engine.
- [ ] **Profiler survives its app frozen with data**: open an app, open its
  Profiler (chart icon) — the title bar reads the session + short instance id
  (e.g. `manual-control · #hw-1`) and graphs/meters/clocks fill live. Close the
  app → Profiler STAYS open, shows the neutral **"Session ended"** banner, polling
  stops (no console error spam), and all accumulated graphs/meters/clocks/spans
  stay browsable; the snapshot-export button is disabled with a tooltip
  (Reveal-folder still works).
- [ ] **Two profilers, each pinned, titles distinguish**: with app A + its
  profiler open, switch to app B and open B's profiler. TWO profiler windows
  coexist — A's frozen (`Session ended`, A's title) and B's live (B's session +
  its own `#hw-N`). Re-clicking B's chart icon re-focuses B's existing profiler
  (one per instance), never a third. A's profiler NEVER re-attaches to B (no live
  data resumes in it).
- [ ] **Crashed vs clean end banners**: SIGKILL/SIGABRT an app's orchestrator
  while its Profiler is open → the Profiler shows the RED **"Session crashed"**
  banner (with the exit code) instead of the neutral "Session ended". A normal
  app close shows the neutral banner. Both freeze the data; neither re-attaches.

### Crash diagnostics (2026-07-09, proposal `orchestrator-lifecycle-and-exit.md` §"Crash diagnostics")

- [ ] **Induced abort → CrashReport shows tail + log path**: with a hardware app
  live, `kill -ABRT <orchestrator-pid>` (get the pid from the profiler / Activity
  Monitor). The app window's CrashReport banner appears with the exit code AND a
  collapsed **"Diagnostics"** disclosure — expand it: the last ~30 lines of the
  orchestrator's output show in a scrollable monospace box (fixed height, does NOT
  grow the banner unbounded / shift page content), and a **"Log · Reveal in
  Finder"** row opens `<userData>/crash-logs/` with the `.log` selected.
- [ ] **crash-logs dir populated**: after the abort, `<userData>/crash-logs/`
  contains `<instanceId>-<timestamp>.log` whose tail matches what the terminal
  showed before death (the ring's last ~256 lines / 64 KiB).
- [ ] **Dev terminal output UNCHANGED**: throughout normal operation the dev
  terminal shows the orchestrator's stdout/stderr exactly as before the pipe/tee
  change — no missing lines, no doubling, no reordered interleave, no added
  buffering lag.
- [ ] **Minidump appears + is cited**: the abort leaves a `.dmp` under
  `<userData>/crash-dumps/` (crashpad), and when present the CrashReport shows a
  **"Dump · Reveal in Finder"** row pointing at it. (Best-effort: on a very fast
  exit the dump may not be flushed in time — the log tail is always present
  regardless.)
- [ ] **No pushTo throw on a disposed frame**: trigger the crash during a
  dev-restart / window close race — main logs `[push] drop …` at debug and does
  NOT throw the old "Render frame was disposed before WebFrameMain could be
  accessed" error; Welcome/next app stay responsive.

## Channel-order fix (2026-07-09, proposal `channel-order-fix.md`)

Killed the B/R flip at the source: `cvtColorCode` now applies the OpenCV↔PFNC
off-by-one Bayer correction (registry-generated `FOVEA_BAYER_CV_FORMATS`) and the
display-bound pipes are canonicalized to HONEST `RGBA8` (converter target, all
brick outputs, every advert). Consumers updated in ONE wave: composite anaglyph
red→ch0, heatmap `BGR2RGBA`, KCF/Stereo gray taps `RGBA2GRAY`, capture demosaic
`makeRGBA` + one honest `RGBA→BGR` at imwrite, viewer decode honest end-to-end.
FrameView unchanged (RGBA-native canvas). A partial land INVERTS the live
preview — verify these together:

- [ ] **Live preview color truth**: a KNOWN-RED object reads RED (not blue) on
  every live preview tile (center + L/R foveae); a blue object reads blue. (Two
  wrongs used to cancel; verify the source is honest now, not that it "still
  looks right".)
- [ ] **Anaglyph left-eye = RED**: disparity-scope "Anaglyph" center view shows
  the LEFT image in the red channel, RIGHT in cyan (put something only the left
  eye sees → it appears red). SGBM/heatmap disparity unaffected.
- [ ] **Heatmap colors**: the disparity heatmap renders TURBO with correct hue
  order (was R/B-swapped before — low disparity blue→ high red, not reversed).
- [ ] **Saved PNG**: capture → save; open the written `.png` in an external
  viewer — a red object is red (imwrite BGR order is honest, not double-swapped).
- [ ] **OLD recording in viewer**: open a raw-Bayer recording made BEFORE this
  fix — it now decodes red-as-red (the fixed viewer decode corrects the same
  off-by-one; NO data migration, raw payloads are label-only).
- [ ] **NEW recording in viewer**: record after the fix, play it back — red-as-red,
  identical to the OLD recording (both decode through the corrected path).

## Configuration window

Code-complete (2026-07-09): app-wide Settings window (singleton `config` class,
Cmd+, / "Settings…" menu), live app-config apply via `useConfigRef` on the shared
`["config"]` store document, per-triple `zoom_override` storage, and a
calibration-data enumerate/delete manager. Store backing routes to the live app
instance (shared store-hub) or a forked non-hardware "settings" instance from
Welcome. Verify on the rig:

- [ ] **Open + store backing (both paths)** — Cmd+, from Welcome (no app) opens
  Settings and reads/writes persist (a non-hardware "settings" instance backs
  it); Cmd+, while an app is running opens the SAME window bound to the app's
  store-hub.
- [ ] **Live marker-size apply** — open **Extrinsic** (or **Drift**) calibration,
  then Settings; dragging Settings' **Calibration marker size** moves the running
  calibrate window's marker-size slider (and readout) in real time, and the
  reverse (calibrate slider → Settings field) also tracks. Same for **ratio**.
- [ ] **TeleCanvas URL live (client mode)** — in **client** mode, set/clear the
  **TeleCanvas server URL** while an app is running; the PUT target changes
  without restart (the app windows push continuously now — no overlay needed).
- [ ] **Default save directory** — set a writable base dir; a newly-opened
  capture/record destination defaults under it (invalid path shows the red
  underline and is ignored).
- [ ] **Triplet zoom_override persists** — expand a triple, set **Zoom override**,
  restart the app, reopen Settings: the value survives AND the triple's
  `drift_l`/`drift_r` are intact (no clobber).
- [ ] **Calibration delete + re-calibrate** — friendly names resolve to the
  connected rig's serials; delete an **Intrinsic**/**Extrinsic**/**Triple** entry
  (Confirm delete), re-run that calibration, and confirm the entry reappears with
  fresh metadata.

### TeleCanvas host mode

Code-complete (2026-07-09): TeleCanvas promoted to a standalone dual-mode module.
**Client** mode PUTs the merged projection SVG to a remote server (unchanged);
**host** mode spins up the app's OWN dependency-free node http server (a
main-owned `telecanvas-host` utilityProcess) that serves a self-contained viewer
page (SSE) and stays `PUT /`-wire-compatible. The push stays in the app windows;
the TeleCanvas window previews via the host's own SSE stream. Verify on the rig
(needs a second device — phone/tablet/TV — on the same LAN):

- [ ] **Host serves a reachable viewer** — Settings (or the TeleCanvas window) →
  **Host** mode; open one of the listed `http://<lan-ip>:<port>/` URLs in a
  browser on a LAN device. The viewer page loads (dark, self-contained) and shows
  the current projection (splash when idle).
- [ ] **Markers move live** — with the LAN viewer open, run **Extrinsic**
  calibration; the markers on the external display track the in-app overlay in
  real time (the app window pushes to `127.0.0.1:<port>`, the host broadcasts to
  the viewer over SSE). The TeleCanvas window's own preview matches.
- [ ] **Mode switch client↔host live** — flip the mode in Settings while an app
  runs; the host server starts/stops accordingly with no app restart, and the
  app's push retargets.
- [ ] **Port change re-listens** — change the **server port** in host mode; the
  host re-spawns on the new port, the reachable-URL list updates, and the LAN
  viewer reconnects at the new URL.
- [ ] **App quit kills the server** — quit the app; the `telecanvas-host` process
  exits (the LAN viewer's page shows "reconnecting…", never a stale live image).
- [ ] **Port persists across restart** — set host mode + a custom port, quit,
  relaunch: the host comes up on that port at startup (before any app window),
  read from the persisted config.

## Blocked (hardware change required)

- [ ] **Center-camera hardware trigger** — needs the slimmer CAM0 cable
  (`rig.md`); until then C free-runs and center captures are one-shot pipe
  reads.
