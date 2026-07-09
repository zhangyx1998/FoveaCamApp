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
- [ ] **Disparity-scope magnification** — absolute magnification (~9×
  expected) + match_left/right quality with the measured fovea↔wide scale
  ratio; projection-plane bake-in check.
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

## Capture/recorder nodes (2026-07-09/10 waves, 388454f→bee815c)

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

## Blocked (hardware change required)

- [ ] **Center-camera hardware trigger** — needs the slimmer CAM0 cable
  (`rig.md`); until then C free-runs and center captures are one-shot pipe
  reads.
