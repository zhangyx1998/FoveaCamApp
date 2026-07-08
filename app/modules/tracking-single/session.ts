// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Single-target tracking session — the first frame-driven control loop moved off
// the renderer (§5.4). The orchestrator leases the calibrated L/C/R triple from
// the camera registry, runs the KCF tracker on the *shared* center stream (via
// the registry's in-process view tap, so it never opens a second handle), and
// drives the actuation loop against the shared serial controller. The renderer is
// a thin client: it pushes parameters as state, steers/engages via commands, and
// renders the L/C/R preview frames + tracker overlay from telemetry.
//
// Triple leasing and the actuation loop are shared with `manual-control`'s
// session (`@orchestrator/calibration`'s `leaseCalibratedTriple`,
// `@orchestrator/actuation`'s `startActuationLoop`) — this used to duplicate
// both inline; refactored onto the shared helpers once manual-control's own
// use of them had landed (docs/refactor/orchestrator.md roadmap items 5/6).

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { startActuationLoop, type ActuationLoop } from "@orchestrator/actuation";
import { createFrameWorker } from "@orchestrator/frame-worker";
import { DisposerBag, publishSerials, releaseLeases } from "@orchestrator/session-resources";
import {
  clampRectToSize,
  depthFromInverse,
  ORIGIN_POS,
  radians,
  VOLT_TELEMETRY_INTERVAL_MS,
} from "@orchestrator/fovea-pipeline";
import { tracking } from "./contract";
import { KinematicModel } from "./kinematic";
import { RECT } from "@lib/util/geometry";
import { createQMatrix, deriveFoveaIntrinsics } from "@lib/stereo";
import { copyMat } from "@lib/mat";
import {
  depthFromProjection,
  diff,
  disparity,
  heatmap,
  reprojectImageTo3D,
  slice,
  wrapPerspective,
  type Mat,
} from "core/Vision";
import { createTracker, type KcfTracker, type TrackerMeter } from "core/Tracker";
import { consumeTrackerResults } from "./tracker-consume";
import { registerNativeProbe } from "@orchestrator/native-probes";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";
import type { Point2d, Rect } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { RollingStats } from "@lib/util/rolling";

const now = () => performance.now();

// A-24 Stage 3: adapt B's native tracker meter (`uptimeMs`/`dropTotal`) to the
// `WorkloadSnapshot` shape `perfSnapshot.workloads` uses, so the profiler
// renders the KCF thread next to the JS meters + the pipe producers.
function trackerWorkload(m: TrackerMeter): WorkloadSnapshot {
  const t = Date.now();
  return {
    name: "tracking:kcf",
    window: { startedAt: t - m.uptimeMs, snapshotAt: t, uptimeMs: m.uptimeMs },
    utilization: m.utilization,
    busyMs: m.busyMs,
    inputs: m.inputs,
    outputs: m.outputs,
    drops: { total: m.dropTotal, ratePerSec: 0, byReason: {} },
  };
}

export default function trackingSession(): ServerSession<typeof tracking> {
  return defineResourceSession("tracking", tracking, (s) => {
    // Leased triple + loaded conversions (held while a renderer is subscribed).
    let triple: CalibratedTriple | null = null;
    let loop: ActuationLoop | null = null;

    // Center-frame geometry, learned from the first frame.
    let width = 0;
    let height = 0;

    // Target state (undistorted center-frame pixels, the actuation math's space).
    let target: Point2d = { x: 0, y: 0 };
    const kinematic = new KinematicModel(() => s.state.pred_buffer_max);
    // WS1 1d: the KCF now runs on its OWN free-running C++ thread (B's
    // `createTracker`) consuming the LATEST center-camera frame (latest-wins,
    // drop-stale) OFF the JS loop — the busy-drop / generation-staleness guard
    // is intrinsic to that thread. `tk` is created per activation; `armed` gates
    // JS-side publishing (there's no native disarm — release kills the thread).
    let tk: KcfTracker | null = null;
    let armed = false;
    let lastGood: Point2d = { x: 0, y: 0 };
    // Latest commanded voltages, mirrored locally so the L/R fovea wrap can use
    // them off the frame path (telemetry-published copy lives in `volt`).
    const volts: { L: Pos; R: Pos } = { L: { ...ORIGIN_POS }, R: { ...ORIGIN_POS } };
    // Aligned (always-wrapped) foveae cached for the diff/depth combined view —
    // independent Mats from `wrapPerspective`, so they survive to the R handler.
    const aligned: { L: Mat<Uint8Array> | null; R: Mat<Uint8Array> | null } = {
      L: null,
      R: null,
    };

    // Control-path latency (perf substrate, docs/refactor/orchestrator.md
    // §7.3 item 2). `lastFrameTime` is the timestamp of the most recent real
    // detection (KCF init/update, not a kinematic prediction) — the "frame"
    // in `frameAgeAtActuate`.
    const trackMsStats = new RollingStats(0.9, 2, "ms");
    const actuateMsStats = new RollingStats(0.9, 2, "ms");
    const frameAgeStats = new RollingStats(0.9, 2, "ms");
    let lastFrameTime: number | null = null;

    // --- tracker (driven by center-frame arrival) ------------------------

    // Clamp a rect to the frame (width/height always >= 1) so `slice`/`cvtColor`
    // never see an out-of-bounds or degenerate (<=0) rect. Needed because a KCF
    // result can drift a bbox toward/past the frame edge; without this,
    // `searchWindow`'s unclamped `right - x` can go negative once `box.x`
    // exceeds `width` — see §12.1 C4.
    function clampRect(r: Rect): Rect {
      return clampRectToSize(r, { width, height });
    }

    function disengage(publish = true): void {
      // No native disarm — stop JS-side publishing/actuation; the thread keeps
      // running (last roi) until `release()` at teardown. Cheap; v1, rig-gated.
      armed = false;
      kinematic.reset();
      if (publish) s.telemetry({ active: false, bbox: null });
    }

    /** Arm the native tracker at a clicked center (undistorted display pixels).
     *  Round-trips the click to a RAW sensor box (what the native full-frame KCF
     *  wants — it reads the raw center stream). */
    function armAt(center: Point2d): void {
      const undistort = triple?.undistort;
      if (!undistort || !tk) return;
      const size = { width: s.state.tracker_w, height: s.state.tracker_h };
      const roi = RECT.fromCenter(
        undistort.position([undistort.angular([center], false)[0]], false)[0],
        size,
      );
      const x = Math.max(0, Math.round(roi.x));
      const y = Math.max(0, Math.round(roi.y));
      const w = Math.min(width - x, Math.round(roi.width));
      const h = Math.min(height - y, Math.round(roi.height));
      if (w <= 0 || h <= 0) return;
      tk.arm({ x, y, width: w, height: h });
      armed = true;
      kinematic.reset();
      lastGood = center;
      target = center;
      lastFrameTime = now();
      kinematic.push(center.x, center.y, lastFrameTime);
      s.telemetry({ active: true, bbox: { x, y, width: w, height: h }, target });
    }

    /** Map a native (RAW center-pixel) bbox to the UNDISTORTED target space the
     *  actuation/slice math uses. COORDINATE MAPPING IS RIG-GATED — verify the
     *  undistort flags against real optics at Stage F. */
    function undistortedCenter(bbox: Rect): Point2d {
      const raw = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
      const undistort = triple?.undistort;
      return undistort
        ? undistort.position([undistort.angular([raw], true)[0]], false)[0]
        : raw;
    }

    /** Consume the native tracker's result stream (its own C++ thread) into the
     *  session's target/kinematic/telemetry state. Ends when `tk.release()`
     *  closes the iterator; staleness/busy-drop is handled natively. */
    function consumeTracker(t: KcfTracker): Promise<void> {
      return consumeTrackerResults(t, {
        armed: () => armed,
        onFound: (bbox) => {
          const center = undistortedCenter(bbox);
          lastGood = center;
          const now_ = now();
          lastFrameTime = now_;
          kinematic.push(center.x, center.y, now_);
          target = kinematic.predict(now_) ?? center;
          s.telemetry({ bbox, target });
        },
        onLost: () => {
          target = lastGood;
          s.telemetry({ target });
          disengage(true);
        },
      });
    }

    // The magnified fovea: a `1/zoom` crop of the undistorted center about the
    // target, published as the `center` frame.
    function publishSlicedView(centerMat: Mat<Uint8Array>): void {
      const undistort = triple?.undistort;
      if (!undistort) return;
      const zoom = Math.max(1, s.state.zoom);
      const size = { width: width / zoom, height: height / zoom };
      const at = undistort.position(
        [undistort.angular([target], false)[0]],
        false,
      )[0];
      const sliced = slice(centerMat, clampRect(RECT.fromCenter(at, size)));
      s.frame("center", sliced);
    }

    // DISPLAY only now (WS1 1d): the KCF moved to its own native thread reading
    // the raw center stream — this JS view-tap just undistorts + publishes the
    // center for the UI (and the sliced fovea). Learns the frame geometry.
    function processCenterView(raw: Mat<Uint8Array>): void {
      const undistort = triple?.undistort;
      const view = undistort ? undistort.apply(raw) : raw;
      const [h, w] = view.shape;
      if (w !== width || h !== height) {
        width = w;
        height = h;
        s.telemetry({ size: { width, height } });
      }
      s.frame("C", view);
      if (s.state.view === "sliced") publishSlicedView(view);
    }

    const centerWorker = createFrameWorker<Mat<Uint8Array>, Mat<Uint8Array>>({
      name: "tracking:center",
      copy: copyMat,
      process: processCenterView,
    });

    function onCenterView(raw: Mat<Uint8Array>): void {
      centerWorker.submit(raw);
    }

    function depthWindow(): number {
      return depthFromInverse(s.state.depthWindowInv);
    }

    // Combined fovea view (diff or depth) from the aligned L/R pair. Called on
    // the R tick, when both foveae are fresh for this frame.
    function publishCombinedView(): void {
      const { L, R } = aligned;
      const undistort = triple?.undistort;
      if (!L || !R || !undistort || !triple) return;
      let out: Mat<Uint8Array>;
      if (s.state.view === "diff") {
        out = diff(L, R, true);
      } else {
        const zoom = Math.max(1, s.state.zoom);
        const Q = createQMatrix(
          deriveFoveaIntrinsics(undistort, triple.conv.V2A.L(volts.L), zoom),
          deriveFoveaIntrinsics(undistort, triple.conv.V2A.R(volts.R), zoom),
          s.state.baseline,
        );
        const proj = reprojectImageTo3D(disparity(L, R), Q);
        const dw = depthWindow() / 2;
        const z = depthFromProjection(proj, distance() - dw, distance() + dw);
        out = heatmap(z);
      }
      s.frame("center", out);
    }

    // Publish each fovea's preview (wrapped iff `wrap`), and cache the
    // always-aligned fovea so the combined diff/depth view can use it.
    function processFoveaView(role: "L" | "R", view: Mat<Uint8Array>): void {
      const H = triple ? triple.conv.A2H[role](triple.conv.V2A[role](volts[role])) : null;
      const wrapped = H ? wrapPerspective(view, H) : null;
      const display = s.state.wrap && wrapped ? wrapped : view;
      s.frame(role, display);
      if (s.state.view === "sliced") {
        aligned.L = aligned.R = null; // not needed; let the Mats be collected
      } else {
        aligned[role] = wrapped;
        if (role === "R") publishCombinedView();
      }
    }

    const foveaWorkers = {
      L: createFrameWorker<Mat<Uint8Array>, Mat<Uint8Array>>({
        name: "tracking:fovea:L",
        copy: copyMat,
        process: (v) => processFoveaView("L", v),
      }),
      R: createFrameWorker<Mat<Uint8Array>, Mat<Uint8Array>>({
        name: "tracking:fovea:R",
        copy: copyMat,
        process: (v) => processFoveaView("R", v),
      }),
    };

    function onFoveaView(role: "L" | "R", view: Mat<Uint8Array>): void {
      foveaWorkers[role].submit(view);
    }

    // --- actuation (timer-driven, decoupled from tracker fps) ------------

    function distance(): number {
      const v = s.state.verge;
      return v <= 0 ? Infinity : s.state.baseline / (v * v);
    }

    function inverseTriangulate(
      angle: Point2d,
      z: number,
      shift: number,
    ): { l: Point2d; r: Point2d } {
      const out = { l: { ...angle }, r: { ...angle } };
      if (z < Infinity && z > 0) {
        const b = s.state.baseline / 2;
        const x = z * Math.tan(angle.x);
        out.l.x = Math.atan2(x + b, z);
        out.r.x = Math.atan2(x - b, z);
      }
      if (shift !== 0) {
        out.l.y += radians(shift);
        out.r.y -= radians(shift);
      }
      return out;
    }

    function targetVolts(): { l: Pos; r: Pos } {
      const undistort = triple?.undistort;
      if (!undistort || !triple) return { l: ORIGIN_POS, r: ORIGIN_POS };
      // Re-evaluate the prediction at "now" so the mirror keeps tracking
      // smoothly between (slower) tracker updates — moved here (was inline in
      // the old actuation loop) so it still runs every actuation tick under
      // the shared `startActuationLoop`. A-12 keeps this exactly here: the
      // predict cadence is the actuation tick, independent of (and unchanged
      // by) the tracker's new async completion timing.
      if (armed) {
        const p = kinematic.predict(now());
        if (p) target = p;
      }
      if (lastFrameTime !== null) frameAgeStats.push(now() - lastFrameTime);
      const angle = undistort.angular([target], false)[0];
      const A = inverseTriangulate(angle, distance(), s.state.shift);
      return { l: triple.conv.A2V.L(A.l), r: triple.conv.A2V.R(A.r) };
    }

    // Cap `volt` telemetry independent of the 1ms actuation tick — publishing
    // every tick is a structured-clone message at ~1 kHz × every subscribed
    // window, which is both wasted work and enough to visibly load a renderer.
    // See §12.1 C6.
    let lastVoltEmit = 0;

    // --- lifecycle -------------------------------------------------------

    // Resource-scoped activation (A-P1). The tracker/kinematic/frame-workers
    // are session-level singletons; per activation we lease the triple, tap the
    // three streams, and start the actuation loop. The scope's drain (LIFO)
    // stops the loop, disengages the tracker, unsubscribes the taps, cancels the
    // frame workers, and releases the leases LAST. `scope` isn't stored — no
    // command needs it — so this stays a thin swap of the old activate/idle.
    async function activateSession(scope: ResourceScope): Promise<void> {
      const t = await scope.use(() => acquireTriple(s), releaseLeases);
      if (!t) return;
      triple = t;
      scope.defer(() => {
        triple = null;
        width = height = 0;
        lastFrameTime = null; // don't carry a stale frame age into the next activation
      });
      scope.defer(() => {
        centerWorker.cancel();
        foveaWorkers.L.cancel();
        foveaWorkers.R.cancel();
      });
      // Tap each stream's Mat in-process: the center is undistorted (+
      // tracked), the foveae are perspective-wrapped, before publishing
      // processed frames. Local bag → one deferred `dispose()`.
      const taps = new DisposerBag();
      taps.push(t.leases.L.onView((v) => onFoveaView("L", v)));
      taps.push(t.leases.C.onView(onCenterView));
      taps.push(t.leases.R.onView((v) => onFoveaView("R", v)));
      publishSerials(t.leases, taps, s);
      scope.defer(() => taps.dispose());
      scope.defer(() => disengage(false));
      // WS1 1d: the KCF tracker thread, bound to the shared center stream. It
      // runs off the JS loop; results stream in via `consumeTracker`. `release()`
      // (scope.defer → drained on idle) closes the iterator + kills the thread.
      tk = createTracker(t.leases.C.camera);
      scope.defer(() => {
        tk?.release();
        tk = null;
        armed = false;
      });
      // A-24 Stage 3: expose the KCF thread's native meter to `perfSnapshot.
      // workloads` (probed out-of-loop; absent when idle). Disposed on drain.
      scope.defer(
        registerNativeProbe(
          (): Record<string, WorkloadSnapshot> =>
            tk ? { "tracking:kcf": trackerWorkload(tk.probe()) } : {},
        ),
      );
      void consumeTracker(tk);
      loop = startActuationLoop({
        targetVolts,
        onVolts(v, actuateMs) {
          volts.L = v.L;
          volts.R = v.R;
          actuateMsStats.push(actuateMs);
          const t = now();
          if (t - lastVoltEmit >= VOLT_TELEMETRY_INTERVAL_MS) {
            lastVoltEmit = t;
            s.telemetry({
              volt: v,
              perf: {
                trackMs: { mean: trackMsStats.mean, max: trackMsStats.max },
                actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max },
                frameAgeAtActuate: { mean: frameAgeStats.mean, max: frameAgeStats.max },
              },
            });
            trackMsStats.resetMax();
            actuateMsStats.resetMax();
            frameAgeStats.resetMax();
          }
        },
      });
      // Registered LAST → drains FIRST: stop the actuation loop before anything
      // it reads (tracker/triple) is torn down.
      scope.defer(() => {
        loop?.stop();
        loop = null;
      });
      s.telemetry({ ready: true });
    }

    return {
      activate: (scope) => activateSession(scope),
      idle() {
        s.resetTelemetry(["ready", "active", "bbox"]);
      },
      commands: {
        async startTracker(center) {
          armAt(center); // (re-)arm the native KCF thread at the clicked target
        },
        async releaseTracker() {
          disengage(true);
        },
        async steer(px) {
          disengage(true);
          target = px;
          s.telemetry({ target });
        },
      },
    };
  });
}
