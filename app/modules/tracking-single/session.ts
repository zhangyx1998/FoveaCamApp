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

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { startActuationLoop, type ActuationLoop } from "@orchestrator/actuation";
import { AsyncKcfTracker } from "@orchestrator/async-kcf";
import { createFrameWorker } from "@orchestrator/frame-worker";
import { DisposerBag, releaseLeases } from "@orchestrator/session-resources";
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
  cvtColor,
  depthFromProjection,
  diff,
  disparity,
  heatmap,
  reprojectImageTo3D,
  slice,
  wrapPerspective,
  type Mat,
} from "core/Vision";
import { KCF } from "core/Tracker";
import type { Point2d, Rect } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { RollingStats } from "@lib/util/rolling";

const now = () => performance.now();

export default function trackingSession(): ServerSession<typeof tracking> {
  return defineSession("tracking", tracking, (s) => {
    // Leased triple + loaded conversions (held while a renderer is subscribed).
    let triple: CalibratedTriple | null = null;
    const disposers = new DisposerBag(); // frame/view tap unsubscribes
    let loop: ActuationLoop | null = null;

    // Center-frame geometry, learned from the first frame.
    let width = 0;
    let height = 0;

    // Tracker + target state. `target` is in *undistorted* center-frame pixels
    // (the tracker runs on the undistorted center, matching the actuation math).
    let target: Point2d = { x: 0, y: 0 };
    const kinematic = new KinematicModel(() => s.state.pred_buffer_max);
    // PB3 A-12: async (`updateAsync`, busy-drop + generation staleness guard)
    // via the shared `@orchestrator/async-kcf` — the last synchronous KCF in
    // an `onView` sink. Search-window/lost-count state lives inside `kcf`.
    const kcf = new AsyncKcfTracker({
      createTracker: () => new KCF(),
      clampRect: (r) => clampRect(r),
      searchWindow: (box, scale) => searchWindow(box, scale),
      cropPatch: (view, win) => cvtColor(slice(view, win), "BGRA2BGR"),
      lostTolerance: () => s.state.lost_tolerance, // live session state
    });
    let pendingInit: Point2d | null = null;
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

    function searchWindow(box: Rect, scale = 1): Rect {
      const px = Math.max(0, s.state.pad_x * scale);
      const py = Math.max(0, s.state.pad_y * scale);
      const x = Math.max(0, Math.round(box.x - px));
      const y = Math.max(0, Math.round(box.y - py));
      const right = Math.min(width, Math.round(box.x + box.width + px));
      const bottom = Math.min(height, Math.round(box.y + box.height + py));
      return clampRect({ x, y, width: right - x, height: bottom - y });
    }

    function disengage(publish = true): void {
      kcf.release(); // also invalidates any in-flight async update (staleness)
      kinematic.reset();
      if (publish) s.telemetry({ active: false, bbox: null });
    }

    function initTracker(view: Mat<Uint8Array>, center: Point2d): void {
      const undistort = triple?.undistort;
      if (!undistort) return;
      const size = {
        width: s.state.tracker_w,
        height: s.state.tracker_h,
      };
      // Round-trip the click through the undistort model so the box lands on
      // the distorted sensor pixel the user aimed at.
      const roi = RECT.fromCenter(
        undistort.position([undistort.angular([center], false)[0]], false)[0],
        size,
      );
      const x = Math.max(0, Math.round(roi.x));
      const y = Math.max(0, Math.round(roi.y));
      const w = Math.min(width - x, Math.round(roi.width));
      const h = Math.min(height - y, Math.round(roi.height));
      if (w <= 0 || h <= 0) return;
      const box: Rect = { x, y, width: w, height: h };
      // Reset the kinematic model with the tracker (disengage), then init —
      // `kcf.init` crops to a tight search window internally (small patch for
      // KCF/cvtColor) and releases any previous tracker/in-flight update.
      disengage(false);
      kcf.init(view, box);
      lastGood = center;
      target = center;
      lastFrameTime = now();
      kinematic.push(center.x, center.y, lastFrameTime);
      s.telemetry({ active: true, bbox: box, target });
    }

    // A-12: results are applied on async completion. Timing semantics
    // preserved from the synchronous version: `lastFrameTime`/`kinematic`
    // are stamped when a real detection RESULT exists (now the completion
    // time — the moment the detection actually becomes available), and the
    // kinematic re-predict still runs every actuation tick in `targetVolts()`
    // (unchanged). Staleness (release/re-init/idle while in flight) resolves
    // to "dropped" inside `kcf.update` — never applied here (V5/V10 class).
    function updateTracker(view: Mat<Uint8Array>, t0: number): void {
      void kcf.update(view).then((result) => {
        if (result.status === "tracking") {
          trackMsStats.push(now() - t0); // async detection latency (see log)
          const center = result.center;
          lastGood = center;
          const t = now();
          lastFrameTime = t;
          kinematic.push(center.x, center.y, t);
          target = kinematic.predict(t) ?? center;
          s.telemetry({ bbox: result.bbox, target });
        } else if (result.status === "lost") {
          target = lastGood;
          s.telemetry({ target });
          disengage(true);
        }
        // "dropped": busy/stale/sub-threshold miss — no observable change.
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

    function processCenterView(raw: Mat<Uint8Array>): void {
      // Undistort up front: the tracker, the actuation math, and the
      // displayed center all operate in the same undistorted pixel space.
      const undistort = triple?.undistort;
      const view = undistort ? undistort.apply(raw) : raw;
      const [h, w] = view.shape;
      if (w !== width || h !== height) {
        width = w;
        height = h;
        s.telemetry({ size: { width, height } });
      }
      if (pendingInit) {
        const center = pendingInit;
        pendingInit = null;
        const t0 = now();
        initTracker(view, center); // KCF.init is synchronous — measured inline
        trackMsStats.push(now() - t0);
      } else if (kcf.active && !kcf.updating) {
        // Busy-drop: skip this tick if the previous async update is still in
        // flight; the completion callback pushes trackMs (detection latency).
        updateTracker(view, now());
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
      if (kcf.active) {
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

    // Named distinctly from the `SessionDefinition.activate`/`idle` hooks
    // below (which call these) — object method shorthand doesn't bind its own
    // name for self-reference, so reusing "activate"/"idle" here would read
    // as (harmless but confusing) recursion.
    async function activateSession(): Promise<void> {
      const t = await acquireTriple(s);
      if (!t) return;
      triple = t;
      // Tap each stream's Mat in-process: the center is undistorted (+
      // tracked), the foveae are perspective-wrapped, before publishing
      // processed frames.
      disposers.push(t.leases.L.onView((v) => onFoveaView("L", v)));
      disposers.push(t.leases.C.onView(onCenterView));
      disposers.push(t.leases.R.onView((v) => onFoveaView("R", v)));
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
      s.telemetry({ ready: true });
    }

    function idleSession(): void {
      loop?.stop();
      loop = null;
      disengage(false);
      disposers.dispose();
      centerWorker.cancel();
      foveaWorkers.L.cancel();
      foveaWorkers.R.cancel();
      releaseLeases(triple);
      triple = null;
      width = height = 0;
      lastFrameTime = null; // don't carry a stale frame age into the next activation
      s.resetTelemetry(["ready", "active", "bbox"]);
    }

    return {
      commands: {
        async startTracker(center) {
          pendingInit = center; // the next center frame performs the KCF init
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
      activate() {
        void activateSession();
      },
      idle: idleSession,
    };
  });
}
