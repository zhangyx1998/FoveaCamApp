# Disparity-scope — developer behavior spec

Developer-facing behavior spec for the `disparity-scope` app session (auto-vergence).
Distinct from the user manual; this captures the state machine, gating semantics,
drag rulings, and precedence rules the code points here for. Code carries only
tight one-line pointers to these anchors.

Topology follows the SPLIT-NODE proposal (`docs/proposals/split-disparity-nodes.md`,
ruled 2026-07-09). The session is a THIN main-thread coordinator: it wires up the
graph and forwards final results; it does not micro-manage frames.

## Pipeline topology {#topology}

On activate: `acquireTriple` (calibration), then advertise THREE undistort pipes and
compose the split pipeline out of GENERAL-PURPOSE nodes.

- **Undistort pipes.** C = INTRINSIC undistort. L/R = HOMOGRAPHY undistort, each fed
  `A2H∘V2A(volts)` by `startHomographyFeeder` (an empty ring passes frames through).
- **Slice nodes** on the C undistort (the fovea crop brick, reused), live-steered by
  `steerCrops` as target/zoom move: `slice/scope-strip` (target-centered match strip)
  and `slice/scope-tile` (display center tile).
- **Scale nodes** (ruling 5 — the match kernel does NO resizing), retuned by
  `retuneScalers` on zoom/magnification/tuning change: the strip's `scale/match`
  (ratio = match scale `s`) and one `scale/scope-needle` per fovea (`dsize` =
  `foveaTileSize`).
- **Template-match workers** (`match/L`, `match/R`): each reads its pre-sized needle +
  the shared pre-sized strip. Results carry the strip frame's crop ORIGIN, so
  `origin + rectCenter/s` is an ABSOLUTE undistorted-wide position — no target or drag
  flag ever rides a worker.
- **PID node** (`win/disparity-scope/pid`) — the app-specific JOIN. See [match join](#match-join).
- **Views.** Sliced/guide views ARE the slice pipes (renderer `usePipeFrame`). The
  L-vs-R difference AND anaglyph center views are a real two-input COMPOSITE brick
  (`stereo/composite`, mode retuned from `state.view`) on the two fovea undistort
  pipes — the renderer DiffView canvas composite is retired. Only the per-side match
  heatmaps remain session frame channels. SGBM disparity + heatmap are separate bricks
  (`createStereoPipe` → `createHeatmapPipe`), PARKED until the renderer connects the
  heatmap pipe (ruling 2 — no subscriber, no compute).

### Needle geometry — the too-small-needle defect {#needle-geometry}

The needle scaler's SOURCE is the RAW fovea CONVERT pipe, NOT the L/R homography-
undistort pipe. The homography warp lands the fovea view at WIDE pixel density (a
demagnified patch) — it has already divided by the magnification once. Feeding that to
the needle scaler (whose `foveaTileSize` dsize divides by magnification AGAIN)
demagnifies TWICE (~9× linear / 81× area too small vs the strip). The raw convert pipe
is the full fovea FOV at fovea-native resolution, so `foveaTileSize` is the SINGLE,
correct ÷magnification (legacy `getFoveaTile` semantics). The warped pipes stay the
stereo/composite source (`warpedSources`) — those bricks WANT the wide-aligned warp.

Base-dims/zoom pairing (`needleGeometry`): a MEASURED magnification is a
fovea-px-per-center-px ratio → divide the FOVEA source dims; a NOMINAL zoom (window
knob or per-triple `zoom_override`, both rig-nominal FOV ratios) → divide the CENTER
dims (legacy `W_c/z`). Pairing either zoom with the other width injects an uncorrected
foveaRes/centerRes factor. The FOVEA branch is taken ONLY when the measured tier
actually WINS the resolution order (decided by tier, not numeric identity).

## Match magnification — ruled resolution order {#magnification}

Ruled 2026-07-09 (per-triplet-settings wave), `matchMagnification`:

    app-window zoom knob (state.zoom > 0)      — AUTHORITATIVE
      > per-triple zoom_override (> 0)          — the rig's stored optical zoom
        > calibration-MEASURED fovea↔wide ratio — extrinsic marker-quad ratio
          > 1                                    — degenerate but honest

`zoom === 0` is "Auto". Each tier must be finite and > 0 to be accepted; a degenerate
value falls through. The knob wins over everything when set, so a live override on the
window is never blocked by a stored triple value. This drives BOTH the tile/strip match
scale AND (via `Math.max(1, matchZoom())`) the sliced-view crop + tracker search sizing.

## Drag = parallel follow {#drag}

Pointer drag → the TRACKER's override (§3.5). Down/move call `tk.override(p)`; the
control step switches to DIRECT FOLLOW (user rulings 2026-07-08/09):

- Pointer-down RESETS pan/verge/v_shift, so BOTH eyes ride exactly ON the raw cursor
  ray — parallel, vergence at INFINITY, no residual corrections — with no PID stepping
  and NO match-score gate (the pure `followTarget`; the match-gated loop could never
  follow a drag onto unmatched content: the strip recenters on the dragged target, the
  foveas' actual gaze leaves the strip, both scores drop below `minScore`, control
  holds, the foveas never move).
- The pointer handler also pushes the follow volts synchronously so the drag doesn't
  lag a match tick, and refreshes the freeze window NOW (`dragging` reaches the join one
  match tick late — a drag started while frozen must servo immediately).
- The all-zero controller state equals the follow command, so on release the tracker
  RE-ARMS at the drag end and the PID resumes CONTINUOUSLY from the parallel pose (no
  seed — velocity-form integrator = command), then re-converges every DOF from scratch.
- `overridden` is SESSION-LOCAL (`dragging`) — nothing app-specific rides the reusable
  nodes. The join stamps it onto each projection.
- The PID node's own override slot stays for the generic `pidOverride` command; its
  seeded release (`seedFromOverride`) serves ONLY that path.

### Drag slew {#drag-slew}

value-sweep 2026-07-11 `disparity-drag-slew` (`drag-slew.ts`). During a drag the mirror
pose used to STEP to each pointer sample then sit still — the serial link idled between
pointer events while the governed stream had ~600–1000 Hz capacity (the compose floor
re-emits an IDENTICAL pose, which the MirrorSink gate dedupes away). Slewing the
commanded pose toward the latest pointer target with a short time constant (τ = 8 ms)
makes successive control ticks emit DIFFERING poses while the target moves — the gate
passes them at capacity — and epsilon-SNAPS to the exact target once settled, quiet on a
static target. Rides the VALUE only: the transport underneath is untouched, so it cannot
resurrect a suppressed JS stream (`dual-cmd-stream-handoff-race`). NOTE (Lane C parity):
manual-control duplicates the same ~15-line function — keep constant/shape consistent.

## Freeze / convergence window {#freeze-window}

`frozen()`: while the auto-follow gate is armed (including the armed-but-hunting window
before the first lock and the hybrid's re-detect recovery) OR found results flow, the
convergence timeout does NOT apply (user ruling 2026-07-11). The timeout exists for
unattended pointer-set targets, not an active tracker. Otherwise `now() - windowStart >
timeout` (timeout ≤ 0 = never). `windowStart` is refreshed on drag/track activity and
reset per activation (value-sweep `freeze-window-not-reset-on-activate`: the clocks were
initialized at session CREATION, so a window re-entering long after boot was already
past the timeout — frozen before the first projection).

## Chained tracker (§3.5) {#tracker}

`createChainedHybridTracker` (NCC match+re-detect, the drop-in KCF successor) or GRAY-KCF
runs on its OWN native thread, chained on the C undistort brick's OwnedFrame tap
(latest-wins), so tracking latency no longer rides the disparity-matching budget.

- **Result routing** (`tracker-feed.ts`, pure reducer): OVERRIDDEN results (a drag
  pinned the tracker) are ALWAYS processed — the `armed()` gate does not apply. Normal
  results are gated by `armed()` (the JS-side auto-follow flag — native has NO disarm;
  released targets keep emitting, the gate ignores them until re-armed). Found →
  `onTrack`; miss → counted, and after `TRACKER_LOST_TOLERANCE` (10) CONSECUTIVE misses
  `onLost()` fires ONCE (counter resets).
- **Lost policy** (`onLost`): release auto-follow (JS gate), hold the last good target,
  restart the convergence window, set `tracker_lost` telemetry (drives the drawer Status
  "lost"; a stale "armed" beside a "frozen" vergence status read as a contradiction —
  UI/UX review 2026-07-11).
- **Hot-swap** (`tracker-swap.ts`, user request 2026-07-11): the two factories share an
  IDENTICAL handle surface (same `TrackResult`/`arm/override/probe/release`/meter), so
  the session releases one and spins the other on the SAME source pipe + graph node id —
  no graph churn, no session restart, only a brief tracker-results gap. Sequencing:
  release → create → resume consume + re-pipe kcf→imm → re-arm IFF `wasArmed`. DEGRADE
  (requirement 4): a factory throw falls back to the previously-running type and pins
  state to reality (`ok:false`); a fallback throw too → null tracker (pointer-only).
- **Deferred swap during drag**: a `tracker_type` change requested WHILE a drag is in
  flight is DEFERRED to drag end (ruled-safe: never re-plumb the tracker mid-gesture;
  pointer-up applies the pending swap and re-arms at the settled pose).

## Match join {#match-join}

Per-side match results land keyed L/R at the PID node. The vergence step runs when the
ARRIVING side COMPLETES a pair (its seq ≥ the other side's latest) — order-agnostic,
~once per strip frame, degrades to the slower side's rate. Each result is lifted out of
scaled-strip space (`/s` → full-res strip-local px) + the frame's forwarded crop origin
→ ABSOLUTE undistorted-wide px.

**Partner staleness** (`match-join.ts`, value-sweep `match-pair-join-no-staleness-bound`):
a stalled partner (dead worker / starved pipe) used to freeze ONE eye's center into the
vergence law indefinitely while status read "tracking". A partner beyond the AGE
(~300 ms) or SEQ-GAP (12 frames) bound is treated as LOST: hold the pose (skip the
control step — existing hold semantics) and surface "match stale". Corrupt clock ⇒ hold.

## Vergence control law & spaces {#control-law}

`stepVergence` (`vergence.ts`) — PURE geometry + control math. The loop integrates
physically-meaningful DOF and reconstructs both fovea poses symmetrically about the gaze
ray, rather than commanding four fovea pixel DOF independently (which lets the foveas
drift apart on noisy frames).

- **DOF.** `pan` = common-mode ray correction x/y (rad, a PID2D); `verge` = inverse-√depth
  parameter (0 ⇒ ∞); `v_shift` = vertical half-shift between the foveas (rad).
- **Error decomposition** (`dL = aT − aL`, `dR = aT − aR`): `pan = (dL+dR)/2`;
  `verge = aR.x − aL.x = 2b(1/Z − 1/z)`; `v_shift = (aR.y − aL.y)/2`. The `v_shift`
  sign is opposite the common-vertical (`pan.y`) one: `v_shift` drives the foveas in
  OPPOSITE vertical directions (`l.y = ray.y + v_shift`, `r.y = ray.y − v_shift`), so
  nulling the differential disparity needs the negated error or `v_shift` winds to its limit.
- **Input space** (post-replumb): projected centres arrive as UNDISTORTED wide-frame
  pixels, so they lift to angles via `P2A.C(px, false)` (already-undistorted linear
  pinhole map, not the raw-pixel default the pre-replumb kernel used). Feeding back on
  the image-MATCHED position (not the calibration-predicted one) lets a constant
  extrinsic offset be absorbed by the loop instead of biasing convergence.
- **Hold** (returns null): either match below `minScore` (also rejects NaN) — the
  controllers are left untouched so a low-confidence frame neither integrates nor winds down.
- **dt.** Velocity (incremental) form, so effect scales with call rate; the caller
  supplies a rate-normalized `dt` to keep convergence wall-clock consistent across
  variable pipeline throughput.

### Seed space contract — the drag-release seam {#seed-space}

`seedVergence` reconstructs the `{pan, verge, v_shift}` state whose forward map reproduces
a pair of per-eye gaze ANGLES about the target ray — the exact algebraic inverse of the
forward reconstruction, so seeding a released PID node gives output continuity.

The inputs are ANGLES, not volts (this was the release-jump bug). The forward law
commands VOLTS via `A2V(reconstruct(...))`; recovering angles from an override VOLT pair
by inverting through `V2A` is LOSSY — `A2V` and `V2A` are independently fitted PER-EYE
regressions, so `V2A.L∘A2V.L ≠ V2A.R∘A2V.R`. A PARALLEL drag round-trips back as two
slightly DIFFERENT angles, which the reconstruction reads as genuine toe-in ⇒ a
FABRICATED verge/v_shift ⇒ the mirrors converge elsewhere the instant control resumes. So
a caller that KNOWS the commanded ray (the disparity drag path) passes it directly as
`gL = gR = ray`: `tanDiff` is exactly 0, verge/v_shift come out 0, and `A2V(ray)`
reproduces the pinned volts exactly. Only the generic volts-only override path (arbitrary
per-eye volts that genuinely encode a vergence) round-trips through `V2A`. `SEED_PARALLEL_EPS`
(1e-9) guards the `z = baseline/tanDiff` divide on the parallel case.

## Actuation / native compose path {#actuation}

Push-model at the projection/PID result rate. `native-compose-controller.md` (supersedes
the wave-1 JS compose node).

- **pushVolts** REBASEs the native compose brick from the pid command (~60 Hz):
  `{V_pid, p_meas, J}` where `J` is the per-eye 2×2 finite-difference (`J_EPS_PX = 1 px`)
  of `followVolts` around the measured target (planner decision 1 — JS owns calibration,
  the brick owns the per-tick `V = V_pid + J·(p_pred − p_meas)`). The brick emits the
  baseline FLOOR on every rebase (decision 4 — the wave-1 JS floor retired).
- **Feed-forward gate** (`composeHealthy`): applied ONLY while control is healthy —
  actively tracking, not dragging, no generic override pinned, not frozen. Otherwise the
  compose node holds the `V_pid` baseline. No calibration for `J` ⇒ hold the baseline.
- **IMM predictor brick**: ALWAYS created while tracking is active (the signed per-triple
  `delay_compensation_ms` is a prediction OFFSET param, not a wire gate), so the imm node
  is always on the profiler graph. Free-runs at the global `prediction_rate_hz`
  (default 600, clamp 60..1000), live-applied via a store subscription; that rate is also
  the serial governor's REQUESTED ceiling (serial-rate-governor.md Part 2).
- **kcf → imm** is a NATIVE PORT LINK (native-port-pipe.md ruling 1: both endpoints
  native, no JS relay), re-established on every hot-swap (a fresh tracker's `track_out`
  must re-pipe into the SAME imm brick). **pid consumes RAW tracker results** (not imm
  predictions): the feed-forward pairs `V_pid` with the measured center it acted on; a
  predicted input would double-count the motion.
- **Transports.** The legacy JS `posInput` is the FALLBACK (v1 firmware / no controller):
  `consumeComposeFallback` drains the compose volt iterator and drives it ONLY while no
  native sink is attached. When a v2 controller binds, the native position input attaches
  a mirror sink, the session pipes `compose.volt_out ══ sink.pos_in`, and the whole
  ~600 Hz path is native; the fallback loop idles as a flag check.
- **Volt telemetry** under the native path polls the sink's native history at the
  telemetry throttle (no per-push JS callback exists). The same timer drives Part 4
  SERIAL-LATENCY COMPENSATION: while `serial_latency_comp` is ON and RTT samples exist,
  the predictor's delay gains a measured one-way term
  (`delayMs = fixed + EMA(ackRttP50)/2`), re-applied only when it moves by >0.05 ms. OFF /
  no sink / no samples = the fixed lookahead exactly.
- **Mirror-history provenance** (planner decision 3): while the native sink drives the
  mirrors, the JS `mirrorHistory` no longer sees this session's trajectory — the
  homography feeder reads the sink's NATIVE ring; falls back to the JS authority whenever
  the JS `posInput` path is driving.

## Teardown ordering {#teardown}

`disposers` is a `DisposerBag` (FIFO). Consumers dispose before producers: pipe
disconnects + tracker/imm/measureLink release, then scalers (chained on slices/undistorts)
→ slices (chained on the C source) → the undistort bricks + homography feeders. Retirers
are added AFTER the kernel inputs are connected so the producer teardown is deferred
after the consumer disconnects. Native port links pin both endpoints, so a link's
disposer runs FIRST (added after the brick disposers). Each stop-feeder runs BEFORE its
brick detaches. `idleSession`: finalize an in-flight recording FIRST (while cameras are
still leased), drain any in-flight capture shot, then close transports and
`disposers.dispose()`.

Load-bearing constraints kept at the code:
- `verge.setLimits(...)`, NOT a bare `.limits =` (value-sweep `verge-integral-clamp-stale`):
  the integral clamp aliases the construction-time array, so replacing `limits` alone left
  the velocity-form command clamped to the default-200 mm baseline range on other rigs.
- `A2P.C` in `onVolts` guards the UNDISTORT, not just the triple — it throws "Wide camera
  not calibrated" without it, fires on EVERY volts push, and the uncaught throw killed the
  orchestrator on an uncalibrated rig (crash log hw-1 2026-07-10T19-31).

## Capture & recording {#capture}

capture-recorder-everywhere ruling 2/3/6. Recording captures the raw L/C/R sensor streams
(advert-verbatim). Capture composes the stacked L/R + center-slice shot over the leased
triple; the degraded `rawTripleShot` writes raw stacks WITHOUT the fovea homography wrap
(the session tracks no per-shot pose to derive H) — stated in `capture_meta`. EXCLUSIVITY
(ruling 6): a recording is refused while a capture shot holds the shared raw pipes, and
vice versa; `busy()` refuses a mid-recording/mid-capture drain.
