// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Manual-control session — same substrate as tracking-single (calibrated
// L/C/R triple + frame-driven display + timer-paced actuation loop) minus
// the KCF tracker: the target is always whatever `steer` last set, either a
// mouse-drag pixel (converted server-side via `undistort.angular`, since the
// renderer no longer holds calibration) or a locally-held set-point's angle
// (pure client-side data, passed straight through with optional per-point
// distance/shift overrides). Capture and recording (docs/refactor/
// orchestrator.md roadmap item 6) are wired in separately — see `capture.ts`/
// `recording.ts` — but their commands are declared on the contract now.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { startActuationLoop, type ActuationLoop } from "@orchestrator/actuation";
import { createFrameWorker } from "@orchestrator/frame-worker";
import { DisposerBag, releaseLeases } from "@orchestrator/session-resources";
import {
  clampRectToSize,
  depthFromInverse,
  ORIGIN_POS,
  radians,
  VOLT_TELEMETRY_INTERVAL_MS,
} from "@orchestrator/fovea-pipeline";
import { manualControl } from "./contract";
import { createCapture } from "./capture";
import { createRecording } from "./recording";
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
import { RECT } from "@lib/util/geometry";
import { copyMat } from "@lib/mat";
import {
  createQMatrix,
  deriveFoveaIntrinsics,
  inverseTriangulate,
  vergeToDistance,
} from "@lib/stereo";
import type { Point2d, Rect } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { RollingStats } from "@lib/util/rolling";

export default function manualControlSession(): ServerSession<typeof manualControl> {
  return defineSession("manual-control", manualControl, (s) => {
    let triple: CalibratedTriple | null = null;
    const disposers = new DisposerBag();
    let loop: ActuationLoop | null = null;

    // Center-frame geometry, learned from the first frame.
    let width = 0;
    let height = 0;

    // Target state — always whatever `steer` last set (no tracker/prediction).
    let target: Point2d = { x: 0, y: 0 };
    let targetAngle: Point2d = { x: 0, y: 0 };
    // Per-set-point overrides (angle mode only); null means "use the base
    // verge/shift state," matching the renderer's original `?? distance.value`
    // / `?? shift.value` fallback for a set-point's unset d/s fields.
    let distanceOverride: number | null = null;
    let shiftOverride: number | null = null;

    // Latest commanded voltages, mirrored locally so the L/R fovea wrap can use
    // them off the frame path (telemetry-published copy lives in `volt`).
    const volts: { L: Pos; R: Pos } = { L: { ...ORIGIN_POS }, R: { ...ORIGIN_POS } };
    // Aligned (always-wrapped) foveae cached for the diff/depth combined view.
    const aligned: { L: Mat<Uint8Array> | null; R: Mat<Uint8Array> | null } = {
      L: null,
      R: null,
    };

    function clampRect(r: Rect): Rect {
      return clampRectToSize(r, { width, height });
    }

    // --- targeting ---------------------------------------------------------

    function baseDistance(): number {
      return vergeToDistance(s.state.verge, s.state.baseline);
    }
    const baseShiftDeg = (): number => s.state.shift;
    const distance = (): number => distanceOverride ?? baseDistance();
    const shiftDeg = (): number => shiftOverride ?? baseShiftDeg();

    function targetVolts(): { l: Pos; r: Pos } {
      if (!triple) return { l: ORIGIN_POS, r: ORIGIN_POS };
      const A = inverseTriangulate(
        targetAngle,
        s.state.baseline,
        distance(),
        radians(shiftDeg()),
      );
      return { l: triple.conv.A2V.L(A.l), r: triple.conv.A2V.R(A.r) };
    }

    function setTargetFromPixel(px: Point2d): void {
      target = px;
      distanceOverride = null;
      shiftOverride = null;
      targetAngle = triple?.undistort
        ? triple.undistort.angular([px], false)[0]
        : { x: 0, y: 0 };
      s.telemetry({ target, target_angle: targetAngle });
    }

    function setTargetFromAngle(
      angle: Point2d,
      distance_mm?: number,
      shift_deg?: number,
    ): void {
      targetAngle = angle;
      distanceOverride = distance_mm ?? null;
      shiftOverride = shift_deg ?? null;
      target = triple?.undistort
        ? triple.undistort.position([angle], false)[0]
        : { x: 0, y: 0 };
      s.telemetry({ target, target_angle: targetAngle });
    }

    // --- display (mirrors tracking-single's onCenterView/onFoveaView, no
    // tracker: no pendingInit/search/lostCount, target is external state) ---

    function publishSlicedView(centerMat: Mat<Uint8Array>): void {
      if (!triple?.undistort) return;
      const zoom = Math.max(1, s.state.zoom);
      const size = { width: width / zoom, height: height / zoom };
      const at = triple.undistort.position([targetAngle], false)[0];
      const sliced = slice(centerMat, clampRect(RECT.fromCenter(at, size)));
      s.frame("center", sliced);
    }

    // PB3 A-5: `undistort.apply` is a full-frame remap — ms-scale, previously
    // run inline in the registry's synchronous `onView` dispatch, which
    // throttled the whole camera serial (see `@orchestrator/frame-worker`'s
    // header for the exact mechanism). The tap now only copies the buffer and
    // hands off to a busy-gated, latest-wins `frameWorker`; `capture.
    // onCenterTick` rides the same (now coalesced) processed-view cadence —
    // it's a promise-resolve for a capture pass awaiting "the next center
    // frame," not vision math, so riding a slightly slower cadence than raw
    // camera rate is harmless (capture.ts has no per-frame deadline).
    // Workload meter names (A-8): stable per-worker identities for
    // `system.perfSnapshot.workloads`. The workers (and their meters) are
    // process-lifetime — this session is a boot-time singleton and the
    // workers persist across idle/activate cycles, so `worker.dispose()` has
    // no call site here on purpose: `ServerSession.dispose()` is a REUSABLE
    // force-idle (releaseCameras, window-switch drain), not a terminal
    // teardown — disposing the meters there would inert them after the
    // first app switch and drop the named rows the snapshot should keep.
    const centerWorker = createFrameWorker<Mat<Uint8Array>, Mat<Uint8Array>>({
      name: "manual-control:center",
      copy: copyMat,
      process(raw) {
        const view = triple?.undistort ? triple.undistort.apply(raw) : raw;
        const [h, w] = view.shape;
        if (w !== width || h !== height) {
          width = w;
          height = h;
          s.telemetry({ size: { width, height } });
        }
        s.frame("C", view);
        if (s.state.view === "sliced") publishSlicedView(view);
        capture.onCenterTick(view);
      },
    });

    function onCenterView(raw: Mat<Uint8Array>): void {
      centerWorker.submit(raw);
    }

    function depthWindow(): number {
      return depthFromInverse(s.state.depthWindowInv);
    }

    function publishCombinedView(): void {
      const { L, R } = aligned;
      if (!L || !R || !triple?.undistort) return;
      let out: Mat<Uint8Array>;
      if (s.state.view === "diff") {
        out = diff(L, R, true);
      } else {
        const zoom = Math.max(1, s.state.zoom);
        const Q = createQMatrix(
          deriveFoveaIntrinsics(triple.undistort, triple.conv.V2A.L(volts.L), zoom),
          deriveFoveaIntrinsics(triple.undistort, triple.conv.V2A.R(volts.R), zoom),
          s.state.baseline,
        );
        const proj = reprojectImageTo3D(disparity(L, R), Q);
        const dw = depthWindow() / 2;
        const z = depthFromProjection(proj, distance() - dw, distance() + dw);
        out = heatmap(z);
      }
      s.frame("center", out);
    }

    // PB3 A-5: `wrapPerspective` (full remap) + `publishCombinedView`'s
    // diff/depth math (disparity, reprojectImageTo3D, heatmap) are the other
    // inline-vision culprit named in PB3 — same fix, one worker per eye (L/R
    // arrive on independent taps, so each gets its own busy-gate; the
    // existing `aligned` cache already tolerates the two eyes being a tick or
    // two apart, same as before).
    function processFoveaView(role: "L" | "R", view: Mat<Uint8Array>): void {
      const H = triple ? triple.conv.A2H[role](triple.conv.V2A[role](volts[role])) : null;
      const wrapped = H ? wrapPerspective(view, H) : null;
      const display = s.state.wrap && wrapped ? wrapped : view;
      s.frame(role, display);
      if (s.state.view === "sliced") {
        aligned.L = aligned.R = null;
      } else {
        aligned[role] = wrapped;
        if (role === "R") publishCombinedView();
      }
    }

    const foveaWorkers = {
      L: createFrameWorker<Mat<Uint8Array>, Mat<Uint8Array>>({
        name: "manual-control:fovea:L",
        copy: copyMat,
        process: (v) => processFoveaView("L", v),
      }),
      R: createFrameWorker<Mat<Uint8Array>, Mat<Uint8Array>>({
        name: "manual-control:fovea:R",
        copy: copyMat,
        process: (v) => processFoveaView("R", v),
      }),
    };

    function onFoveaView(role: "L" | "R", view: Mat<Uint8Array>): void {
      foveaWorkers[role].submit(view);
    }

    // --- capture (docs/refactor/orchestrator.md roadmap item 6) ----------

    const capture = createCapture({
      getTriple: () => triple,
      volts: () => volts,
      targetAngle: () => targetAngle,
      centerFrameSize: () => ({ width, height }),
      zoom: () => s.state.zoom,
      capStack: () => s.state.cap_stack,
      baseline: () => s.state.baseline,
      wrapEnable: () => s.state.wrap,
      steerToAngle: setTargetFromAngle,
      frame: (name, payload) => s.frame(name, payload),
      telemetry: (patch) => s.telemetry(patch),
    });

    // --- recording (docs/refactor/orchestrator.md roadmap item 6) --------

    const recording = createRecording({
      getTriple: () => triple,
      volts: () => volts,
      telemetry: (patch) => s.telemetry(patch),
    });

    // --- actuation -----------------------------------------------------

    let lastVoltEmit = 0;
    const actuateMsStats = new RollingStats(0.9, 2, "ms");

    // --- lifecycle -------------------------------------------------------

    async function activateSession(): Promise<void> {
      const t = await acquireTriple(s);
      if (!t) return;
      triple = t;
      disposers.push(t.leases.L.onView((v) => onFoveaView("L", v)));
      disposers.push(t.leases.C.onView(onCenterView));
      disposers.push(t.leases.R.onView((v) => onFoveaView("R", v)));
      loop = startActuationLoop({
        targetVolts,
        onVolts(v, actuateMs) {
          volts.L = v.L;
          volts.R = v.R;
          actuateMsStats.push(actuateMs);
          const now = performance.now();
          if (now - lastVoltEmit >= VOLT_TELEMETRY_INTERVAL_MS) {
            lastVoltEmit = now;
            s.telemetry({
              volt: v,
              perf: { actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max } },
            });
            actuateMsStats.resetMax();
          }
        },
      });
      s.telemetry({ ready: true });
    }

    // V1 (docs/refactor/orchestrator.md §6): a capture or recording pass can
    // still be actively reading `lease.camera.stream` directly when the last
    // subscriber leaves — releasing leases out from under it is the same bug
    // class as C2 (force-close under an active consumer). Both must fully
    // drain *before* leases are released. The `onView` taps must stay live
    // during that drain: a capture can be waiting on the *next* center-view
    // tick (`capture.onCenterTick`) to resolve, so disposing them first would
    // deadlock `capture.waitIdle()` forever.
    async function idleSessionAsync(): Promise<void> {
      loop?.stop();
      loop = null;
      const releasing = triple;
      triple = null; // new activity sees "not ready" instead of racing the drain
      s.telemetry({ ready: false });
      await Promise.all([recording.stop(), capture.waitIdle()]);
      disposers.dispose();
      // PB3 A-5: the display-vision workers persist across idle/activate
      // cycles (same object, not recreated); `cancel()` drops anything they
      // still have scheduled so a frame copied just before this idle can't
      // get processed later against a fresh reactivation's `triple` (the
      // V5/V10/V13 stale-completion class) — safe to call only now, after
      // the drain above, since the workers must stay live (still calling
      // `capture.onCenterTick`) while a capture pass may be waiting on them.
      centerWorker.cancel();
      foveaWorkers.L.cancel();
      foveaWorkers.R.cancel();
      releaseLeases(releasing);
      width = height = 0;
    }

    // Returned (not fire-and-forgotten) so the runtime records the settlement
    // promise — the multi-window drain path awaits it via `session.drained()`
    // before the next app window may activate (multi-window.md §3).
    function idleSession(): Promise<void> {
      return idleSessionAsync();
    }

    return {
      commands: {
        async steer(t) {
          if (t.mode === "pixel") setTargetFromPixel(t.value);
          else setTargetFromAngle(t.value, t.distance_mm, t.shift_deg);
        },
        async previewVolts(queries) {
          if (!triple) return queries.map(() => ({ l: ORIGIN_POS, r: ORIGIN_POS }));
          return queries.map(({ value, distance_mm, shift_deg }) => {
            const A = inverseTriangulate(
              value,
              s.state.baseline,
              distance_mm ?? baseDistance(),
              radians(shift_deg ?? baseShiftDeg()),
            );
            return { l: triple!.conv.A2V.L(A.l), r: triple!.conv.A2V.R(A.r) };
          });
        },
        async runCapture({ setpoints }) {
          await capture.run(setpoints);
        },
        async saveCapture({ path, format }) {
          await capture.save(path, format);
        },
        async discardCapture() {
          capture.discard();
        },
        async startRecording({ path }) {
          return recording.start(path);
        },
        async stopRecording() {
          await recording.stop();
        },
      },
      activate() {
        void activateSession();
      },
      idle: idleSession,
      // Drain-refusal probe (multi-window.md §5 default 2): a window switch
      // must not force-drain this session mid-capture/recording — the user
      // gets a prompt instead of losing an in-flight pass.
      busy() {
        if (capture.busy) return "capture in progress";
        if (recording.active) return "recording in progress";
        return null;
      },
    };
  });
}
