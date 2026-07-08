# Unified time + uniform node topology (proposal)

Status: RULED (user, 2026-07-08); **P1–P3 LANDED same day** (f678ce2 time
core; eba04d8 System.Timestamp v1.1; 1534585 NodeReport contract; 6dbcd50
chained bricks + Topology.report(); d973ab4 integration; 4732f64 edge
tx/rx/drop/max-interval flows). Remaining: §7 P4 (triggered-path calibration,
drift model, FIN-voltage preference) + the marked native TODOs (KCF rows in
Topology.report(), legacy private chains retire when sessions re-chain).
Everything hardware-touching is RIG-GATED via docs/hardware/stage-f.md.

## Rulings (user, 2026-07-08)

1. **Estimator: min-filter** (PTP-style min over N by RTT/dt; p90−min as
   jitter).
2. **Camera↔host: TimestampLatch first**; the 1 ms-exposure frame-pull
   fallback exists but is **config-gated, DISABLED by default**.
3. **Brick chaining: the thread-node infra supports TWO transports
   implicitly** — SHM for IPC, and for in-process threading the
   `core/lib/Threading` channels: **FIFO (lossless)** or **Leaky
   (latest-only)**; build on that infra where features are missing. (SHM is
   not the in-process chain; §5 revised accordingly.)
4. **Controller: add a dedicated firmware command for timestamp RESET +
   timestamp READ (calibration ping)**. Timestamp must not overflow
   mid-task — ≥ 12 h, higher preferred. (The firmware clock is already a
   wraparound-corrected uint64 `Time<micros, uint64_t>` — Global.cpp — so
   width is satisfied; the command is the new surface. The read must be
   answered from the MCU loop with minimal jitter — timestamp the packet at
   parse time, not at reply-queue time.)

## Directive (user, 2026-07-08)

1. Undistort attaches to **convert** nodes — consumes BGRA/RGBA only, never
   Bayer raw; produces undistorted frames **on demand** (parked when no
   consumer). Center undistort uses the **intrinsic camera matrix**; the
   fovea cameras (L/R, mirror-steered) use a **homography derived from the
   mirror position at the frame's (past) timepoint**.
2. A **universal interface for node topology reporting** — minimize
   per-node-type discrepancies.
3. Mirror-position infrastructure: a **short memory of mirror positions vs
   timestamps**.
4. A **uniform clock**: all hardware timestamps aligned to one host time
   source. Offset estimation:
   - free-running cameras: pull N (default 10) frames at 1 ms exposure, use
     the averaged host↔device dt (one camera at a time);
   - controller-triggered cameras: trigger 10 × 1 ms-exposure frames via the
     controller, derive dt between controller and frame timestamps;
   - center camera and controller: always the pulling method (no trigger
     cable — `docs/hardware/rig.md`).
   Abstract measurement into reusable utilities; hide the complexity inside
   the boot sequence (camera acquisition); expose only clean calibrated
   timestamps on one unified time source.

## 1. Host time origin — recommendation

**Master clock: `process.hrtime.bigint()` in the orchestrator** (steady,
monotonic, integer ns), anchored ONCE at boot to wall time
(`{ hrtimeNs, epochMs }` pair) for human-readable labeling only.

Why not the alternatives:

| Candidate | Verdict |
|---|---|
| `performance.now()` | Same underlying clock, but float ms and a PER-PROCESS origin (`timeOrigin` differs across orchestrator/main/renderers). Fine for local intervals, wrong as a cross-process origin. |
| `Date.now()` / wall clock | NTP slews and steps mid-session — unusable for dt measurement. Keep only as the boot anchor label. |
| `CLOCK_MONOTONIC_RAW` | Marginally better (no NTP frequency slew) but not reachable from JS without native help; hrtime's slew is ppm-level and the drift model (§4) absorbs it. |

Caveats to own:
- hrtime **pauses during system sleep** (mach_absolute_time). Detect wake via
  a wall-vs-steady delta jump → **invalidate all calibrations** and re-run.
- Every other clock (camera tick counters, MCU micros, renderer
  `performance.now`, Aravis `system_timestamp`) maps INTO orchestrator
  steady-ns via calibrated `{offsetNs, skew}` pairs. One direction, one
  origin.
- Aravis already stamps every buffer with `system_timestamp`
  (wall-clock ns at USB completion, carried through SlotHeader) — use it as a
  free continuous residual/drift monitor, not as the origin.

## 2. Offset estimation — recommendation (deviations flagged)

Utilities (all pure-testable, hardware injected):

```
estimateOffset(samples: {refNs, subjectTs}[]): { offsetNs, jitterNs }
pullCameraOffset(camera, { n=10, exposureUs=1000 })      // directive method
latchCameraOffset(camera, { n=10 })                      // RECOMMENDED fast path
pulledControllerOffset(controller, { n=10 })             // MCU↔host
triggeredPathOffset(controller, camera, { n=10 })        // trigger-path dt (L/R)
```

**Deviation 1 — min-filter, not mean.** Transfer/latency noise is strictly
one-sided (a frame can arrive late, never early). The mean absorbs tail
latency; the **minimum** (or 10th percentile) over N samples converges on the
true fixed offset. Same trick PTP uses. Report jitter (p90−min) as the
confidence number.

**Deviation 2 — prefer GenICam `TimestampLatch` when available.** Loop:
`t0 = hrtime(); camera.executeFeature("TimestampLatch"); t1 = hrtime();
device = camera.getFeatureInt("TimestampLatchValue")` →
`offset = (t0+t1)/2 − device`, min-filtered over N by RTT. No exposure
reconfiguration, no streaming, ~ms per sample, and it works mid-session
(cheap periodic re-calibration). Uses ONLY the existing generic feature
accessors. The 1 ms-exposure frame-pull stays as the fallback for cameras
without the feature — RIG-CHECK which of the three support it.

**Controller↔host (RULED): dedicated `System.Timestamp` command** — GET
returns the MCU's uint64 micros (stamped AT PARSE TIME, not reply-queue
time, to keep jitter at the serial-latency floor); SET/execute resets the
counter. N pings bracketed by host hrtime → min-by-RTT midpoint, same
estimator. No camera in the loop. Firmware + shared protocol table +
core/Controller decode + `Controller.readTimestamp()`/`resetTimestamp()`.

**Triggered path (L/R when controller-triggered)** — keep the directive's
method exactly: 10 controller-triggered 1 ms frames; dt between the FIN
`t_trigger`/`t_exposure` and the frame's device timestamp measures the REAL
trigger path (cable + FrameStart latch latency), which composes with
controller↔host to place triggered frames on host time. Consistency check
(worth logging): `cam↔host (latch)` ≈ `cam↔ctrl (triggered) + ctrl↔host`.

**Drift**: camera/MCU oscillators drift 10–50 ppm (up to ~3 ms/min). One boot
calibration is not enough for long sessions. Keep the estimator cheap
(latch/ping) and re-run every ~30 s in the background, fitting
`{offsetNs, skew}` over the last few points; free-running cameras also get a
free per-frame residual from Aravis `system_timestamp`.

**Exposure**: device timestamps latch at exposure START (SFNC). The directive's
1 ms exposure minimizes ambiguity during pulls; for real frames, consumers
that want exposure-CENTER time add `exposure/2` themselves (documented, not
hidden in the offset).

## 3. Boot integration + API surface

Hidden inside camera acquisition (today: `acquireTriple` / `registerShared`),
exposed as:

```ts
// orchestrator/time-align.ts
type ClockId = `camera:${serial}` | "controller" | "renderer:<windowId>";
hostNowNs(): bigint                          // THE origin (hrtime.bigint)
toHostNs(clock: ClockId, ts: bigint): bigint // calibrated map (throws if uncalibrated)
calibration(clock): { offsetNs, skew, jitterNs, at } | null
```

- `acquireTriple` kicks `calibrateClocks(...)` (async, non-blocking): latch
  (or pull) per camera + controller ping when connected; publishes readiness +
  jitter via the system session so the UI/profiler can show clock health.
- Frame consumers (recorder, fovea homography, sync pairing) call
  `toHostNs("camera:<serial>", frame.deviceTimestamp)` — no per-app math.
- Results already carrying `deviceTimestamp` (KCF batches, worker results)
  gain host-time interpretation for free.

## 4. Mirror-position history

`orchestrator/mirror-history.ts`: fixed-size ring (e.g. 4096 samples ≈ 4 s at
1 kHz) of `{ hostNs, left: Pos, right: Pos }`.

- Writers: the actuation loop records `predictVolts` output at every SENT
  stream update; `actuate()` records its readback; FIN outcomes record the
  exposure-averaged voltage (ground truth for triggered frames — prefer it
  when present, Stage-F).
- Reader: `mirrorAt(hostNs)` → linear interpolation between neighbors +
  `ageNs`/confidence; used by the fovea homography (`H(mirrorAt(frameHostNs))`).
- Honesty note: commands ≠ physical position — the mirror follows with LPF
  group delay (~1.3 ms at the 120 Hz LPF) + settle. v1 records commands;
  the delay constant is a calibratable offset later (drift rig data can
  measure it). FIN averaged voltage bypasses the issue for triggered frames.

## 5. Undistort re-plumb (BGRA-in, on demand)

Today `UndistortStream`/`FoveaStream` tap the RAW `Arv::Stream` and fuse
Bayer-convert + remap in one pass. Directive: consume the CONVERTED stream.

**RULED (supersedes the pipe-chaining recommendation): the thread-node infra
carries TWO implicit transports.** In-process brick→brick links use the
`core/lib/Threading` channels — **FIFO** (lossless, e.g. recorder taps) or
**Leaky** (latest-only, the default for vision stages) — extended where
features are missing (a Leaky<T> handoff needs an owned-buffer element type
so the producer never recycles a frame under the consumer: the converter
HANDS OFF a frame object rather than exposing its reusable scratch, retiring
the `ConvertedFrame` reuse-contract hazard by ownership transfer instead of
by copy). SHM pipes remain the IPC transport only (renderers, workers,
recorder) — advertised per node output exactly as today, gate-parked on
consumer refcount 0.

Demand propagation must span both transports: a node runs iff (SHM consumers
> 0) OR (≥1 in-process subscriber active); undistort demanded → convert
runs. The graph edge derives from the actual channel connection either way —
no hand-declared "physical edge" special cases.

Semantics per camera:
- **Center**: classic intrinsic undistort (initUndistortRectifyMap — maps
  cached, unchanged).
- **L/R (fovea cams)**: `warpPerspective` with `H(mirrorAt(frameHostNs))` —
  per-frame homography from §3+§4, mapping the steered view into the wide
  frame. H recomputed per frame (9 numbers; the warp dominates).
- Fovea crop slots become crops of the undistorted output (same pipe-chaining,
  `.../undistort/fovea/<slot>` finally matches the physical dataflow).
- Raw Bayer never leaves the converter.

## 6. Universal node reporting

One shape, every node type:

```ts
type NodeReport = {
  id: string;                 // path id (nodeId builders)
  kind: string;               // convert | undistort | fovea | kcf | kernel | …
  transport: "pipe" | "native" | "worker" | "port" | "sink";
  inputs: { from: string; port: string; type: StreamType }[]; // ACTUAL connections
  output: StreamType | null;
  stats?: WorkloadSnapshot;   // one schema (already converged)
  owner?: string;             // win/<windowId> for composed nodes
  epoch?: number;
};
```

- Native: ONE `Topology.report()` NAPI returning `NodeReport[]` for every
  live brick (converter/undistort/fovea/kcf/multi-kcf/pipe), replacing the
  per-family `*ProbeAll()` + `Pipe.list()` derivation.
- JS: workers post the same shape (meterName machinery generalizes); session
  wirings become plain `NodeReport`s.
- `buildTopology` = concat + fold stats by id. Edges come from `inputs` — no
  synthesized edges, no statsKey folding, no special cases. The profiler
  renders whatever is reported; a node missing from the graph means it isn't
  reporting, never that derivation guessed wrong.

## 7. Phasing

- **P1 (pure infra, unit-tested)**: time-align estimator + utilities;
  mirror-history ring; NodeReport contract + buildTopology on reports
  (compat shim for current probes).
- **P2 (hardware integration, RIG-GATED)**: latch/pull calibration in
  acquisition; controller ping; calibration telemetry in profiler.
- **P3 (native re-plumb)**: pipe-chained undistort (center intrinsic; L/R
  homography via mirror history); fovea slots re-based on undistort output;
  `Topology.report()` NAPI; retire ProbeAll + wiring shims.
- **P4**: triggered-path calibration (L/R via controller), drift model,
  FIN-voltage preference in mirror history.

## Open questions (for the user)

1. Min-filter (recommended) vs the directive's mean for offset estimation?
2. TimestampLatch-first with frame-pull fallback (recommended), or
   frame-pull only?
3. Pipe-chained bricks (recommended, §5) vs in-process stream chaining?
4. Controller↔host via direct command ping (recommended) vs always through
   triggered frames?
