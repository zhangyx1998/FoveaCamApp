# Stage-F — rig verification playbook

Fresh checklist (2026-07-10, through `32876c6`), organized **by sub-app**.
Each item: what to do → what to expect. Verified items are removed (git
history has them). Cross-app platform checks live in the first two sections.

> **PREREQUISITES**
>
> 1. ⚠ **Flash v2.0.0 firmware first**: `cd firmware && make upload`.
>    Protocol v2.0.0 is breaking (CMD_FRAME grew `settle_time`); un-flashed
>    major-1 firmware fail-closes (`v2Capable=false`) and multi-fovea shows a
>    reflash hint instead of streaming.
> 2. Core is `-O2` since 756a899 — **all pre-2026-07-10 HIL/utilization
>    numbers are invalid**; re-baseline anything you compare against.
> 3. `RIG-TUNE`: `PRESET_ANGLE_LIMIT_DEG` (multi-fovea/contract.ts, ±10°
>    conservative) → set to the mirror's real safe deflection.

## Platform — lifecycle, crash, quiescence

### App/instance lifecycle (disposable orchestrator)
- [ ] **Open/close/switch cycling** — ≥10 cycles across manual-control ↔
  disparity-scope ↔ multi-fovea: leases acquire/release every time, Welcome
  always returns, no USB3Vision access-denied, no exit-6 abort.
- [ ] **Hardware-clear gate** — on app switch, the brief "waiting for previous
  session to release hardware…" step shows, then acquires. No double-lease.
- [ ] **Spin-up progress** — every app open shows the step overlay
  (⏳ → spinner → ✓); a failed activation freezes at the dying step.
- [ ] **Spawn latency** — note `boot.*` spans; new-app spin-up overlaps the old
  instance's teardown (not serialized behind quiesce).
- [ ] **Induced teardown wedge** — wedge an outgoing app: killed at ~4s bound +
  janitor sweeps; Welcome and the next app stay responsive.
- [ ] **Probe behavior** — Welcome camera list live from the probe; probe pauses
  while an app runs, resumes at Welcome; killing it → main respawns.
- [ ] **darwin no-park** — closing all windows (headless menu bar) leaves only
  the probe; dock re-activate restores Welcome.

### Quiescence & crash (safety invariant)
- [ ] **Graceful Cmd-Q** — windows cascade closed, quiesced ack, MEMS Disable
  echoed, no janitor, no orphan processes.
- [ ] **Crash janitor** — `kill -9`/`-ABRT` the orchestrator mid-tracking:
  mirrors park, cameras released, crash banner (code N) in that app window
  only, relaunch finds nothing locked.
- [ ] **Main hard-crash** — `kill -9` main: the detached watchdog quiesces
  (MEMS off on serial); exactly ONE watchdog per instance; exits after clean
  quit. Also confirm core loads under ELECTRON_RUN_AS_NODE.
- [ ] **Wedged quiesce on quit** — bounded kill → janitor → "killed" report.
- [ ] **Cmd-Shift-R dev restart** — janitor fallback fires if quiesce wedges;
  no duplicate watchdogs.
- [ ] **Controller disconnect** — title-bar disconnect while enabled: MEMS
  Disable echoes before the port releases.
- [ ] **Teardown hardening soak** — ≥20 open/close cycles of each brick-heavy
  app: no `destroyed without shutdown()` abort, no destroyed-mutex EINVAL, no
  hang. Long-run disparity-scope + hard kill: exits without abort OR prints
  the native crash-handler banner + backtrace first.
- [ ] **Crash diagnostics** — induced `kill -ABRT`: CrashReport shows exit code
  + Diagnostics disclosure (last ~30 log lines, fixed height) + Log/Dump
  Reveal rows; `<userData>/crash-logs/` + `crash-dumps/` populated; dev
  terminal output unchanged (no missing/doubled lines); no pushTo throw on a
  disposed frame.
- [ ] **Guard tests on the rig machine** — core tests 36 + 38 pass locally.

### Window & menu chrome
- [ ] **Cmd/Ctrl-W** — app close respawns Welcome; profiler/projection just
  close.
- [ ] **Launcher grouping** — Welcome shows Applications / Calibration /
  Utilities; no tracking-single anywhere; old layouts referencing it degrade
  silently.
- [ ] **Visual parity spot-check** — under rig lighting: brighter/instant error
  surfaces, action-green #4caf50, ProgressMonitor × visible dim at rest.

## Controller & time base (cross-app, serial bench)

- [ ] **Serial rate** — `controller:<port>` packets/sec at kHz-class with
  streaming; manual-control drag shows per-stream Hz ≫ 60.
- [ ] **predictVolts accuracy** — predicted volts match sampled Actuate
  readback (firmware echoes commanded channels).
- [ ] **FW5 coexistence** — streamed actuation + CMD_FRAME captures together:
  no `Streams::snapshot` corruption, FIN voltages sane.
- [ ] **Mirror follows streamed targets** — manual-control drag moves the
  physical mirrors (CREATE auto-activates the DAC stream).
- [ ] **fps ceiling** — camera node output rate at 30 ⇒ suspect stored config
  (frame_rate / exposure > ~16ms), not the pipeline.
- [ ] **Clock calibration live** — profiler Clocks fills within seconds of
  camera open (method latch, jitter ~50–150µs); driftPpm appears after the
  first 30s re-run; TimestampLatchValue unit (ns assumed) per camera model;
  missing latch support → visible fallback diagnostic.
- [ ] **Controller ping** — Clocks shows the `controller` row, jitter ≪ 500µs;
  old firmware times out gracefully (3s) instead of wedging connect.
- [ ] **Offset sanity** — camera + controller offsets stable across reconnects
  and sleep/wake; enable/disable cycles do NOT reset the MCU clock.
- [ ] **Trusted-time end-to-end** — recorded camera frames vs FIN
  tTrigger/tExposure agree to ~ms; sync.ts deltas collapse to trigger-path
  latency.
- [ ] **Mirror history** — during streamed actuation `mirrorAt` age stays
  ~1 tick.
- [ ] **Pairing root rate** — live round-robin trigger: matched-pair rate ≈
  FIN rate, unmatched-FIN ≈ 0 at the 8ms tolerance (tune from measured
  per-side deltas); downstream pair stages emit at root rate with matching
  keys; pairing bricks idle cheaply in free-run; no thread leaks across
  session churn.
- [ ] **Trigger-line names** — GenICam trigger/strobe names in sync.ts are
  UNVERIFIED placeholders — confirm against the real camera model FIRST.
- [ ] **FIN exposure voltage (firmware v2 follow-up)** — FIN reports the
  exposure-AVERAGED voltage bound to its frame (currently initial reading;
  `volt.source: "fin-averaged"` labels the source, not the algorithm).

### MEMS DAC recovery (v2.1.0 — flash first; right-dac-freeze M1–M3)

Diagnosis + hypothesis ranking: `docs/dev/right-dac-freeze-2026-07-12.md`.
Firmware v2.1.0 ships the mitigations; the discriminator below settles H1
(latched DAC power-down) vs H2 (driver latch-up) vs H3 (host wedge).

- [ ] **Discriminator (run when the right mirror next freezes, WITHOUT
  restarting the app)** — in order: (1) CMD_ACTUATE a new right position —
  moves ⇒ host-side after all (H3); (2) title-bar Controller dropdown →
  **Recover mirror** (System::Reset MEMS, no rail cycle) — recovers ⇒ **H1
  confirmed**; (3) disable→enable (rail cycle) — recovers only here ⇒ H2;
  (4) scope SCLK + right SYNC at the right driver connector vs left.
- [ ] **M1 auto-refresh efficacy** — with v2.1.0's 1 Hz config re-assertion,
  the freeze should self-heal within ~1 s (or stop recurring entirely).
  Soak a 600 Hz stream ≥ 1 h; log any residual freeze longer than 2 s.
- [ ] **M1 no-motion invariant** — refresh words never move the mirror:
  parked beam stays put across refresh ticks (scope/camera, 10 min).
- [ ] **M2 in-session recovery** — Recover mirror preserves the session:
  stream keeps updating, targets re-committed within one tick, no
  re-enable needed; REJ path (disabled system / old firmware) surfaces in
  the error tray instead of wedging.
- [ ] **M3 SPI clock** — scope the actual SCLK after the divider (2 MHz
  requested; the retired comment claimed 20→10 MHz measured). Confirm
  mirror steering latency is unaffected at 600 Hz streaming.

### Trigger settle time (v2.0.0)
- [ ] **Settle hold on switch only** — scope a trigger line (or FIN
  `t_trigger − t_exposure` deltas): with settle = 5ms the trigger asserts
  ≈5ms after the mirror command on a stream SWITCH; same-stream frames have
  no added delay.
- [ ] **Exposure unchanged** — pulse/strobe width identical at settle 0 vs 5ms
  (settle only delays the edge).
- [ ] **0 = identical** — settle 0 timing matches a pre-v2.0 build exactly.

## Manage Cameras

- [ ] **Preview marathon** — long-running previews: no transfer-pool GC freeze.
- [ ] **12-bit readout A/B** — live capture in each listed 12-bit format
  (preview-safe option filtering; end-to-end code-complete).
- [ ] **Serial-labeled graph** — manage-cameras' node graph keeps SERIAL names
  (role labels are app-context only).

## Manual Control

### Trigger sync + native center views (2026-07-12 port — flash v2.x firmware)

Proposal: `docs/proposals/manual-control-trigger-and-views.md`. All
RIG-GATED — no hardware on the authoring box.

- [ ] **Capture Mode engage** — Trigger sync engages with a leased triple +
  v2 controller + live position stream; the status row flips to engaged and
  `trigger` telemetry reads an achieved rate ≈ the exposure-budget pace;
  Free-run flip cleanly reverts both cameras to free streaming.
- [ ] **Blocked reasons** — engaging without a controller / on v1 firmware /
  before the stream attaches names the actual missing piece in the tray and
  auto-engages once it appears (intent latch + retry tick).
- [ ] **Trigger + steering coexistence** — drag steering keeps working while
  engaged (stream UPDATEs between CMD_FRAMEs); no REJ storm, mirror follows.
- [ ] **Center views** — disparity (difference), anaglyph (style follows
  `anaglyph_style`, live retune), and SGBM heatmap render correctly on the
  center tile; selecting each connects only its pipe (others park in the
  profiler graph); `sliced` still rides the magnified session frame.
- [ ] **Legacy coercion** — a session persisted with the old diff/depth view
  values lands on disparity/sgbm respectively, no crash, no blank tile.

- [ ] **Views at camera rate** — L/R + center render at camera rate while the
  display kernel meters lower; undistort nodes visible in the graph.
- [ ] **Undistort calibration source** — B's native remap uses the intended
  camera matrix (`mtx`), not an alternate.
- [ ] **Push-model actuation feel** — drag/servo feel unchanged vs the old
  1ms loop.
- [ ] **Split fovea (per-eye drag)** — drag an L/R **voltage bar** (`PosView`):
  that eye's mirror follows the drag at pointer rate, the OTHER eye holds its
  command, the `⟂ independent` badge lights, and the two per-eye footprint
  boxes on the Center Wide view (cyan L / greenyellow R) physically separate.
  Both bars can be dragged at once. Volt-space, so it also works uncalibrated
  (footprint boxes hidden without a center calibration; drag still steers).
- [ ] **Split reunify** — a Center Wide drag OR a set-point selection clears the
  split (both eyes back on the shared solution, boxes converge, badges clear);
  releasing a voltage-bar drag does NOT reunify (the eye holds); re-entering
  Manual Control starts unified (session-local, not persisted).
- [ ] **Capture wrap default** — captures always save WRAPPED foveae; confirm
  downstream consumers expect this.
- [ ] **Cmd-R** — toggles recording here; no-op in apps without it; only the
  FOCUSED window toggles.
- [ ] **Raster capture** — N set-points → N indexed resources with per-shot
  metadata; preview re-focuses (never toggles shut); Esc aborts and retires
  pipes.
- [ ] **Capture ⇄ recording exclusivity** — typed refusal both ways; no wedge,
  recording file intact.
- [ ] **Capture full-depth parity** — same resources as pre-wave captures,
  byte-identical on live sensor formats; `significantBits` matches
  `frame.raw_format`.
- [ ] **F1 capture regression** — capture completes; a stalled port REJECTS at
  10s with a named message ("center delivered 0/5…"), never wedges.

## Disparity Scope

### Tracker (hybrid NCC — swapped in bc20269; runtime-selectable 2026-07-11)
- [ ] **Locks and follows** — enable tracker on a textured target: box locks,
  stays locked, follows motion. No flash-then-disappear, no parking on
  "armed". (History: two OpenCV 4.13 KCF regressions fixed, then the hybrid
  NCC node replaced KCF entirely; KCF remains one line away for A/B.)
- [ ] **Engine hot-swap mid-tracking** — with the tracker locked, flip the
  drawer Tracker select Hybrid ↔ KCF: steering continues, the new engine
  re-arms at the current target within a frame or two, the graph node
  persists (same id, no re-layout), and the kcf → imm prediction chain keeps
  flowing. A swap mid-drag applies at drag end. If a factory is unavailable
  the select snaps back to the running engine.
- [ ] **Tracking never freezes vergence** — with the tracker ARMED or
  TRACKING (including armed-but-hunting, before first lock), the convergence
  timeout never fires (status never "frozen"). After a lost-latch the drawer
  Status reads "lost" (not a stale "armed") and the timeout resumes from that
  moment; disabling the tracker likewise restarts the window.
- [ ] **Re-acquires after loss** — occlude or jerk the target out of the
  search window: the recovery ladder re-locks within a few frames (KCF never
  did — this is new behavior).
- [ ] **Tracker rate + headroom** — the `…/undistort/kcf` graph node meters
  its own thread at frame rate with low utilization (~0.4ms/update budget);
  disparity kernel throughput holds or improves while tracking.
- [ ] **Tracks what the matcher sees** — bbox overlay aligns with the
  undistorted C view, including near edges.
- [ ] **kcf → pid target edge is truthful** — locked+accepted tracking shows
  ~frame-rate on the edge; 0Hz there now MEANS results are rejected (not
  locked, or the JS lost-latch closed — toggle the tracker to re-arm).
- [ ] **Drag = parallel follow** — drag on C: override badge lights, both
  foveas track the raw cursor ray in parallel (vergence ∞, pan/verge/v_shift
  RESET at pointer-down — a visible snap is intended); works over blank
  content; depth reads ∞; status "manual"; snappy (pointer rate).
- [ ] **Release re-arms, no jump** — release with auto-follow ON re-arms at the
  drag end; OFF holds the target; mirrors continue from the in-flight pose.
- [ ] **Lost policy** — ~10 consecutive misses drop the auto-follow gate
  (status back to armed-off, target holds last-good).

### Delay compensation (IMM predictor, imm-delay-compensation.md)
- [ ] **Sign flips lead ↔ lag** — set a triple's Delay Compensation (Settings →
  Device config) to +30 ms: on a smoothly moving target the mirrors lead
  (foveas run ahead of the tracker bbox); flip to −30 ms → they lag behind by
  the same visible amount. Magnitude scales with target speed.
- [ ] **0 = identical behavior** — Delay Compensation 0 (or blank) is an EXACT
  passthrough: tracking/steering is byte-for-byte the pre-feature behavior, and
  the graph shows the plain `kcf → pid` edge (no imm node).
- [ ] **Graph reads kcf → imm → pid** — with a non-zero delay the
  `…/undistort/kcf/imm` node appears between the tracker and pid with truthful
  rates on BOTH edges (rx ≈ tracker rate, tx ≈ pid target rate; no 0 Hz).
- [ ] **Override/drag unaffected** — dragging during compensation: the drag
  point drives the mirrors untouched (predictor passes overridden results
  through + resets); on release no lurch from stale predicted velocity.
- [ ] **Lost streak unchanged** — misses still propagate (found=false rides
  through); the ~10-miss lost-latch fires exactly as without compensation; a
  re-acquire snaps back with no teleport spike (innovation gate).

### Matching pipeline
- [ ] **Split-node graph** — slice/scale/match-L/match-R/pid nodes all render
  with individual meters; no orphan monolithic kernel row.
- [ ] **Match parity + join rate** — per-side rects/scores equivalent to the
  pre-split matcher; join ≈ strip rate (degrades to the slower side).
- [ ] **Live steering** — drag/zoom re-steers crops next-frame; Template Scale
  retunes live; extreme combos clamp, never crash.
- [ ] **Needle footprint** — match rects on the debugger strip are
  fovea-footprint sized (≈ `foveaWidth/matchZoom`), scores healthy; watch
  raw-vs-rectified score degradation over the fovea FOV.
- [ ] **Zoom resolution chain** — knob > triple override > measured > 1:
  `Zoom = 9` → needle dsize ≈ 160×120; `Zoom = 0` + fresh extrinsic → "Auto
  ≈9×"; old extrinsic + 0 → honest 1× fallback, no NaN.
- [ ] **Zoom-scaled pose markers** — L/R pose rects on C draw at the fovea
  footprint (`size/zoom`), tracking the Zoom knob.
- [ ] **Guide strip == sliced tile** — strip is the center tile × expansion;
  its center marker overlaps the sliced view's crop.
- [ ] **Chained undistort visual parity** — the center undistort (chained on
  the shared converter) matches the old fused output; overlays (target dot,
  pose rects, bbox, match rects) align on the undistorted C view.
- [ ] **L/R homography orientation (OPEN)** — the homography-feeder.ts
  question: conv.A2H H vs its inverse/wide-frame composition. A wrong guess
  is a harmless warp; the passthrough meter names it — verify and fix the
  one seam.

### Views & center select
- [ ] **Center dropdown** — view select visible on ALL center views, switches
  live.
- [ ] **Anaglyph truth** — red = LEFT eye (cover left fovea → red goes dark);
  each Settings anaglyph style card maps colors as named; C/R mirrors R/C;
  style changes retune live (no reconnect/frame gap).
- [ ] **SGBM + heatmap** — selecting SGBM starts stereo+heatmap bricks (graph
  rows + meters); textured scene → plausible TURBO depth ordering (near =
  hot), correct hue order.
- [ ] **Paired SGBM** — with trigger pairing live: no disparity smearing on a
  laterally moving target (vs latest-wins); `pairDrops` ≈ 0 while SGBM keeps
  up; sheds OLDEST with metering when overloaded.
- [ ] **Park/resume** — deselecting SGBM/anaglyph/sliced views parks their
  bricks (rates → 0, CPU baseline); reselect resumes within a frame or two.
- [ ] **Views at pipe rate** — sliced view, guide strip, composite tile each
  render at their pipe's rate.
- [ ] **Live preview color truth** — a known-red object reads RED on every
  live tile; saved capture PNG red-as-red in an external viewer.

### Debugger window
- [ ] **Toggle + cascade** — Debugger button opens/closes the sub-window
  without draining the app; closing/switching the app closes it too.
- [ ] **Column alignment** — a strip feature at column x peaks at the same
  display column in the L/R match rows, including near edges.

### Session & layout
- [ ] **Drawer padding** — with the drawer open, the page scrolls to reveal
  ALL content (nothing hidden behind the drawer). Same check in every
  drawer app.
- [ ] **PID/controller edges** — pid → controller edge shows the real push
  rate (≈ strip rate); match → pid edges show rx rates; FIFO undistort edge
  shows queue hwm/cap with zero drops under load.
- [ ] **Teardown** — exiting retires tracker → scalers → slices → undistort
  cleanly (no brick-leak warnings); immediate re-entry works; ≥10 open/close
  cycles with tracker + views live, no freeze/CPU runaway.

## Multi-Fovea

### Demo presets + settle (v2.0.0 — flash first)
- [ ] **Demo interleaves out of the box** — open the app: two foveas alternate
  at (−5°,−5°) / (+5°,+5°) with zero setup; drawer pan/tilt edits re-park
  live; Reset restores the ±5° pair; inputs clamp at ±10° (RIG-TUNE).
- [ ] **v2 hint on old firmware** — on major-1 firmware the app shows the
  "requires v2.0 firmware" hint instead of a silent blank interleave.
- [ ] **Per-triple settle honored** — a triple's `settle_time_us` from Settings
  seeds the drawer slider at the NEXT session start; unset → 0.
- [ ] **Drawer live-override** — moving the Settle slider on a running session
  changes the hold on subsequent switches immediately.

### Tracking & preview
- [ ] **Preview tiles render** — per-target fovea tiles show real pixels
  (C-20 maxBytes fix); composed preview + multi-target tracking quality.
- [ ] **Auto-follow sustains** — multi-KCF (GRAY-pinned) keeps lock on
  textured targets; note vs disparity-scope's hybrid for a future migration
  call.
- [ ] **Frame scheduler** — `scheduler.start()` pumps CMD_FRAME on live v2
  hardware; per-target imagery lands in the right slots.

### Recording
- [ ] **12p payload verbatim** — live 12p recording: payload length ==
  W·H·3/2; `unpack12p` matches a wire capture bit-exactly.
- [ ] **Zero-loss raw12p** — L/C/R raw12p ≥60s full rate: written == ingested,
  0 drops, flat main-loop util.
- [ ] **Descriptor↔frame pairing** — under round-robin trigger, descriptors
  point at the L/R seqs actually aimed at that target; center pointer =
  nearest free-run; free-run recordings carry bbox + null L/R.
- [ ] **Extras binding** — per-frame `{volts, V2A, H}` match the triggering
  FIN anchor; free-run frames get NO extras.
- [ ] **PAIR_FRESH_MS (1s)** — each target revisited inside the freshness
  window at your target count × dwell; stale pairs degrade to null L/R.
- [ ] **Wide camera matrix** — `fovea:wide-camera` metadata matches the
  triple's center intrinsics (also feeds viewer-export undistort).
- [ ] **Record button + Cmd-R focus** — title-bar record works; Cmd-R toggles
  the focused window only; hover stats show the three raw12p streams.
- [ ] **Compression toggles** — under `record_compression=zlib` only checked
  streams route `/zlib`; under `none` the toggles are disabled with the
  Settings hint.
- [ ] **Pipes park** — no recording/capture active → raw pipes at zero rate,
  producers released.

## Calibrate (Intrinsic / Distortion / Extrinsic / Drift)

- [ ] **Marker servo parity** — drift/extrinsic servoing converges as before
  (PID2D bit-identical on bench; confirm feel).
- [ ] **Per-eye drag override** — drift/extrinsic: dragged eye pins
  (controllers held), other keeps servoing; release resumes from the
  released pose.
- [ ] **Baseline live re-spacing** — Settings → triple Baseline change moves
  the TeleCanvas markers immediately in extrinsic/drift/distortion; empty
  falls back to the 200mm app default.
- [ ] **Verge limit from baseline** — disparity-scope verge max reflects the
  triple baseline at next activate (mid-session edits deliberately don't).
- [ ] **Drift gating** — Update buttons disabled while a tracker is unlocked
  or Δ < 0.03°; derived drift null when unlocked; derived value matches
  physical reality.
- [ ] **Checker + intrinsic polish** — projected checkerboard scales with
  pattern-size-mm; live solve shows finite RMS; record thumbnails render;
  marker scale slider drives "Detector @ N Hz".
- [ ] **Recording/capture everywhere** — record button + Cmd-R in all four
  wizards (intrinsic = selected camera); capture works in the triple apps +
  intrinsic; files play in the viewer.
- [ ] **Drawer padding** — extrinsic + drift pages scroll clear of the drawer.

## Viewer (fcap)

### Playback core
- [ ] **Standalone** — plays with the orchestrator DOWN; survives app
  switches and orchestrator kill/restart mid-playback.
- [ ] **Open paths** — record→stop auto-opens; Cmd-O (fcap+fovea filter);
  legacy `.fovea` opens; same-file dedupe focuses; dev restart restores
  windows onto their files; window close releases the file handle.
- [ ] **Scrub feel** — dragging the playhead follows the pointer with no lag
  (latest-wins seek coalescing); backward scrub past a channel's first frame
  leaves that tile on its last frame (known pre-existing gap).
- [ ] **Rig-container decode** — 12p unpack + debayer colors correct (Bayer
  order!); F3 striped BayerRG12p regression stays clean (play + paused
  scrub); `/zlib` channels decode; mid-file channels seek cleanly; old
  (pre-channel-order-fix) and new recordings both show red-as-red.
- [ ] **Crash-shape recovery** — a footer-less container (orchestrator killed
  mid-record) still opens via the streaming re-index reader.
- [ ] **Timeline + sidecar** — master wide track detected; block drag/snap/
  overlap-refusal persists; divider + drawer collapse; per-pair 3D dropdown
  (anaglyph red=L, styles match Settings); sidecar survives reopen; deleted
  ui.json re-inits; corrupt prompts before overwrite; `.fcap` mtime stable.

### Footprint projections (7692e9d, proposal fovea-footprint-overlay.md)
- [ ] **Free-run extras recorded** — a FREE-RUN multi-fovea recording on a
  calibrated triple carries per-frame volt/angle/affine with
  `volt.source: "history-interpolated"`; uncalibrated or controller-less
  recordings omit them (no fake pose).
- [ ] **Footprint lands on the physical fovea region** — the projected quad on
  the wide tile matches where the fovea actually looked (⚠ shares the
  H-vs-inverse OPEN question with the homography feeder — a mirrored/warped
  quad means the recorded H direction is wrong AT THE SOURCE, fix there).
- [ ] **Hover + toggle semantics** — default: hovering a timeline block (or a
  box) shows that stream's box only, both directions highlight; "show all
  projections" draws every active stream; boxes vanish past a stream's block
  (no stale projections); pair shares one color; depth readout on hover reads
  a plausible vergence-plane distance (needs a NEW recording — old containers
  show "—", no baseline).

### Export (new, 32876c6)
- [ ] **ffmpeg gating** — with ffmpeg installed the per-stream export entry
  opens the dialog; without it (or launched from Finder pre-PATH) the entry
  hints ffmpeg is missing rather than failing.
- [ ] **Dialog dependencies** — codec change re-fills pixel formats;
  transparency only enabled where codec+pixfmt support alpha (shows
  EFFECTIVE state, never disabled-but-checked); undistort default-ON on the
  designated wide stream only — fovea/calibration-less/undesignated streams
  disabled WITH a reason.
- [ ] **Undistorted export** — a wide-stream ProRes 4444 export with
  transparency: straight lines straighten, out-of-bounds corners transparent
  (black under non-alpha formats).
- [ ] **FPS + timing** — detected fps ≈ true rate, overridable; "as-is" vs
  "resample + blend" both produce smooth CFR output (blend visibly smooths
  an irregular source).
- [ ] **Queue + tray** — multiple exports queue serially by default (parallel
  option honored); tray icon shows overall %, hover shows per-stream state/
  fps/eta; failures visible; "Clear finished" removes terminal rows.
- [ ] **Abort paths** — per-job abort kills ffmpeg + removes the partial file;
  closing the window (or quitting) mid-export prompts, confirming aborts +
  deletes partials, canceling keeps everything intact.
- [ ] **Degraded-performance banner** — opening a viewer alongside a running
  app shows the dismissable banner (pushes content down); dismiss holds for
  that episode and re-arms after the app closes and a new session starts;
  tray hover echoes the note while exporting.

## Settings window

- [ ] **Open + backing (both paths)** — Cmd+, from Welcome AND while an app
  runs; reads/writes persist in both. (Main is the config authority now — no
  settings instance is forked; verify none appears in Activity Monitor.)

### Config sync matrix (main-authority rework, config-store-main-authority.md)
- [ ] **Settings + hardware app simultaneously (previously broken)** — edit
  marker size / anaglyph style in Settings → a running calibrate window
  updates live, and the reverse direction tracks too.
- [ ] **Different-key concurrent writes both survive** — two windows edit two
  DIFFERENT config keys within a moment; restart; both values persisted (no
  whole-doc clobber).
- [ ] **Instance churn doesn't kill sync** — with Settings open, open then
  close an app; keep editing Settings; edits still persist and still
  broadcast (the store connection no longer dies with an instance).
- [ ] **TeleCanvas ↔ Settings live** — both windows open; mode/url/port edits
  in one reflect in the other immediately.
- [ ] **Orchestrator-internal subscriber** — change anaglyph style from
  Settings while disparity-scope runs: the composite brick retunes live
  (cross-instance broadcast reaches the orchestrator).
- [ ] **Probe path** — with no app open, edit a camera role; Welcome's camera
  list reflects it (the probe reads config through main).
- [ ] **Two tabs, fixed header** — Global / Device tabs switch instantly (no
  fade); the tab header stays pinned while the content scrolls; horizontal
  layout never shifts on switch.
- [ ] **Device tab default = connected rig** — with a rig plugged in, Device
  config opens on that triple with a plug badge; the selector modal opens
  centered + scrollable (doesn't shift the page), lists every configured triple
  connected-first, and lets you pick a DISCONNECTED triple (shows "not
  connected", still editable/saves).
- [ ] **Live apply** — marker size/ratio sliders track bidirectionally with a
  running calibrate window; TeleCanvas client URL retargets pushes without
  restart.
- [ ] **Per-triple fields persist** — zoom_override, Baseline, Settle
  (ms, "none" at 0), and Delay Compensation (ms, signed, "none" at 0) survive
  restart without clobbering drift_l/drift_r; friendly names resolve to the
  rig's serials. Full calibration inventory (incl. disconnected-rig orphans)
  stays reachable + deletable under the Device tab.
- [ ] **Calibration manager** — delete an Intrinsic/Extrinsic/Triple entry,
  re-run that calibration, entry reappears with fresh metadata.
- [ ] **Anaglyph style cards** — four split-swatch cards render truthfully,
  selection carries the accent without layout shift.
- [ ] **Default save directory** — new capture/record destinations default
  under it; invalid path shows red underline, ignored.
- [ ] **record_compression** — `none` (default) is byte-for-byte previous
  behavior; `zlib` routes generic recording through `/zlib` with honest drop
  attribution; applies at recording START only; none/zlib/pre-setting
  recordings all decode identically.

## TeleCanvas (host mode — needs a LAN device)

- [ ] **Host serves** — Host mode → LAN URL loads the self-contained viewer
  (splash when idle).
- [ ] **Markers live** — extrinsic calibration markers track in real time on
  the LAN viewer AND the TeleCanvas window's own preview; a late-joining
  viewer still gets current content.
- [ ] **Mode/port churn** — client↔host flips live; port change re-listens +
  updates the URL list; quit kills the host process (viewer shows
  "reconnecting…", never a stale image); custom port persists across
  relaunch.

## Profiler & node graph

### Graph readability (2026-07-10 upgrade — eyeball pass)
- [ ] **Idle vs stalled** — parked producers (no downstream consumer) render
  desaturated/dashed with an "idle" caption; a demanded-but-0Hz node keeps
  the normal (non-idle) styling; a pegged (saturated) node is NEVER dimmed.
  OPEN user call: should demanded-0Hz get its own red/amber accent?
- [ ] **Layout + curves** — LR flow with edges leaving right-middle, entering
  left-middle; curved stems; bidirectional pairs (PID feedback) separate
  visibly; labels legible on curves; no node/label overlap at default zoom.
- [ ] **L/C/R labels** — app graphs label camera chains by role (`C/kcf`,
  `L/convert`) with role-tinted borders; manage-cameras keeps serials.
- [ ] **Renderer collapse** — SHM consumers fold into ONE renderer node with
  per-pipe fan-in edges (consumer counts in hover detail); graph feels less
  cluttered.
- [ ] **Hover gradient** — hover fades the graph by distance (near opaque,
  far dim-but-visible), nearest on top, 0.2s opacity ease; dragging a node
  keeps it on top; idle nodes stay capped at their dim level when hovered
  (gut-check: is the halo enough feedback?).
- [ ] ~~Resize centering~~ SUPERSEDED by the 2026-07-12 handrolled rework
  below (the panel is no longer height-resizable; resize now refits
  `viewportContent`).
- [ ] **Stats-only refresh stability** — nodes never move or flash on the 1Hz
  poll; dragged positions survive.

### Graph rework (2026-07-12 handrolled SVG — eyeball pass)

Proposal: `docs/proposals/profiler-graph-handrolled.md` (cytoscape+dagre
replaced by the NodeGraph SVG component + Sugiyama-lite layout).

- [ ] **Layout quality vs dagre** — the real rig graph (3 camera chains +
  control lane + recorder/renderer fan-in) lays out with no node overlap,
  sensible ranks, and the PID feedback edge readable. This is the one spot
  the handrolled layout could regress vs dagre — judge on the DENSEST live
  graph (disparity-scope with recording active).
- [ ] **Trackpad feel (macOS)** — two-finger scroll pans X/Y naturally;
  pinch zooms centered on the pointer; pan stops exactly when the canvas
  center hits the graph bbox edge (never lose the graph off-screen).
- [ ] **Live drag** — arrows re-lay smoothly on every drag frame on the
  dense graph (no visible lag at 60 Hz with ~40 nodes).
- [ ] **Tab fill** — graph fills the tab with no scrollbar at any window
  size; other tabs still scroll; fullscreen enter/exit refits the previously
  visible content (viewportContent), not the whole graph.
- [ ] **Marching dash** — hovering a node/edge marches the active
  neighborhood edges source→target; idle edges keep the static dash; warn-red
  edges march in red.
- [ ] **Hover card modes** — Settings → `profiler_hover_card`: `follow`
  tracks the cursor with quadrant flips at all four container edges;
  `corner` snaps to a corner that never covers the hovered element; switching
  the setting applies live without reopening the profiler.

### Profiler platform
- [ ] **V12 live check** — opening the profiler mid-tracking: mirrors keep
  moving, previews unaffected.
- [ ] **Pinned lifecycle** — profiler binds its app instance (title shows
  `session · #hw-N`); app close → frozen with "Session ended", data
  browsable, export disabled; crash → RED "Session crashed" + exit code;
  two profilers (frozen A + live B) coexist; re-click focuses, never spawns
  a third; A never re-attaches.
- [ ] **HIL re-baseline** — export a fresh snapshot set (pre-flight + PB2) on
  the -O2 build for the record; expect lower convert/undistort/tracker
  utilization than any pre-07-10 numbers.

## Recording core (native recorder — cross-app)

- [ ] **Hover drop attribution** — force a drop (throttle disk): hover splits
  `droppedQueue` (writer busy) vs `droppedRing` (reader lagged) correctly.
- [ ] **Finalize under load** — stop at full rate: container finalizes
  (summary/footer) and opens with all frames; a legitimately large container
  finalizes well inside 30s.
- [ ] **Flat container path** — recordings land as `<dir>/<seq>.fcap` (no
  per-recording directory); popup shows the `.fcap` suffix;
  already-exists outline fires; Cmd-R quick path identical; auto-open +
  Finder reveal point at the file.
- [ ] **Old recordings open** — pre-native `.fovea`/`.fcap` containers open
  unchanged.

## Blocked (hardware change required)

- [ ] **Center-camera hardware trigger** — needs the slimmer CAM0 cable; until
  then C free-runs BY DESIGN (ruled 2026-07-10: high-fps wide is intentional
  for smoothness/response — do not sync it without a new ruling).
