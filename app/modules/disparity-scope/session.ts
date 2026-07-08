// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Disparity-scope session — the §1 flagship migration (docs/refactor/
// orchestrator.md §7.1 S1a): auto-vergence, ported off the renderer onto the
// same substrate tracking-single/manual-control proved (`leaseCalibratedTriple`,
// registry `onView` frame-driven vision, `startActuationLoop`). The renderer
// becomes a thin client: it pushes tuning/target as state, drags/releases the
// wide view via the `pointer` command, and renders L/C/R + combined-fovea +
// template-match previews from telemetry/frames.
//
// Control-loop shape, adapted from the original (renderer-bound, raw-`Frame`
// `Zip`-iterator) implementation onto per-camera `onView` taps that don't
// arrive frame-synchronized:
//  - Each fovea's `onView` tap wraps its own Mat (perspective-rectified onto
//    its current pointing pose — always, independent of the `wrap`
//    *display* toggle, since matching/diff are more meaningful against a
//    rectified tile; `wrap` only picks what the L/R *preview* frames
//    show) and derives a grayscale, downsampled match tile from it
//    (`vergence.ts`'s `getFoveaTile` — safe to retain past the call, unlike
//    the registry's reused-buffer Mat itself; see that function's doc).
//  - The center tap drives the actual control step: once both tiles are
//    available, `analyzeVergence`/`stepVergence` run against the latest
//    cached tiles + the just-arrived center frame (one step per center tick,
//    reentrancy-guarded so a slow analysis can't overlap the next tick).
//  - Actuation itself is decoupled onto `startActuationLoop`'s fixed-rate
//    timer (same substrate as tracking-single): the vergence step only
//    updates a cached `commandedVolts`; `targetVolts()` just returns it
//    synchronously every tick. This matches "frame-driven analysis, fixed-
//    rate actuation" exactly as tracking-single already established.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { startActuationLoop, type ActuationLoop } from "@orchestrator/actuation";
import { createFrameWorker } from "@orchestrator/frame-worker";
import { DisposerBag, publishSerials, releaseLeases } from "@orchestrator/session-resources";
import {
  clampRectToSize,
  ORIGIN_POS,
  radians,
  VOLT_TELEMETRY_INTERVAL_MS,
} from "@orchestrator/fovea-pipeline";
import {
  disparity,
  DEFAULT_TUNING,
  VERGE_MIN_DISTANCE_MM,
  SHIFT_LIMIT_DEG,
  VSHIFT_LIMIT_DEG,
  type Tuning,
  type PidReadout,
} from "./contract";
import {
  analyzeVergence,
  stepVergence,
  getFoveaTile,
  foveaTileSize,
  type VergencePIDs,
} from "./vergence";
import { AsyncKcfTracker } from "@orchestrator/async-kcf";
import { RECT } from "@lib/util/geometry";
import { copyMat } from "@lib/mat";
import { PID } from "@lib/pid";
import { distanceToVerge, vergeToDistance, vergenceToDistance } from "@lib/stereo";
import { RollingStats } from "@lib/util/rolling";
import { cvtColor, diff, slice, wrapPerspective, type Mat } from "core/Vision";
import { KCF } from "core/Tracker";
import type { Point2d, Rect } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";

const ZERO: Point2d = { x: 0, y: 0 };
const now = () => performance.now();

// Physical saturation limits — ported unchanged from the original renderer
// implementation (a bad estimate can at worst rest at a limit). Degree limits
// live in contract.ts (shared with the renderer's slider ranges).
const SHIFT_LIMIT = radians(SHIFT_LIMIT_DEG);
const VSHIFT_LIMIT = radians(VSHIFT_LIMIT_DEG);
const DT_MAX_FRAMES = 10;
const TRACKER_LOST_TOLERANCE = 10;
function cloneTuning(t: Tuning): Tuning {
  return {
    pan: [...t.pan],
    depth: [...t.depth],
    v_shift: [...t.v_shift],
    sensitivity: t.sensitivity,
    scale: t.scale,
    min_score: t.min_score,
    expand_x: t.expand_x,
    expand_y: t.expand_y,
    timeout: t.timeout,
  };
}

export default function disparityScopeSession(): ServerSession<typeof disparity> {
  return defineSession("disparity-scope", disparity, (s) => {
    let triple: CalibratedTriple | null = null;
    const disposers = new DisposerBag();
    let loop: ActuationLoop | null = null;

    let width = 0;
    let height = 0;

    // Latest per-eye match tiles (independent Mats — see `getFoveaTile`'s doc).
    let tileL: Mat<Uint8Array> | null = null;
    let tileR: Mat<Uint8Array> | null = null;
    // Latest wrapped (always independent) full-res fovea Mats, for the
    // "disparity" combined view — same pattern as tracking-single's `aligned`.
    const aligned: { L: Mat<Uint8Array> | null; R: Mat<Uint8Array> | null } = {
      L: null,
      R: null,
    };
    let stepBusy = false; // reentrancy guard: one vergence step at a time

    let dragging = false;
    let windowStart = now();
    let lastStep = now();
    let lastVoltEmit = 0;
    let status = "initializing";
    // Commanded volts, updated by the (async, frame-driven) vergence step and
    // read synchronously every actuation tick.
    let commandedVolts: { l: Pos; r: Pos } = { l: ORIGIN_POS, r: ORIGIN_POS };
    // Latest actuated volts, mirrored locally (needed for the wrap homography
    // and the vergence/distance telemetry, same as tracking-single's `volts`).
    const volts: { L: Pos; R: Pos } = { L: { ...ORIGIN_POS }, R: { ...ORIGIN_POS } };
    const actuateMsStats = new RollingStats(0.9, 2, "ms");

    // Optional wide-angle KCF tracker (auto-follow): tracked bbox center
    // drives `state.target`, same as the original renderer implementation.
    // PB3 A-4: async (`updateAsync`, busy-drop + staleness-guarded) — see
    // `@orchestrator/async-kcf` (shared with tracking-single since A-12);
    // `session.ts` only supplies the geometry/dep glue below.
    const kcf = new AsyncKcfTracker({
      createTracker: () => new KCF(),
      clampRect: (r) => clampRect(r),
      searchWindow: (box, scale) => searchWindow(box, scale),
      cropPatch: (view, win) => cvtColor(slice(view, win), "BGRA2BGR"),
      lostTolerance: () => TRACKER_LOST_TOLERANCE,
    });
    let lastGood: Point2d = ZERO;
    // Deferred like tracking-single's `pendingInit`: the registry's `onView`
    // Mat is only valid for the duration of its synchronous call, so a tracker
    // (re)init requested from a command handler can't use a Mat handed to an
    // *earlier* tick — it's applied on the *next* center tick instead.
    let pendingTrackerInit: Point2d | null = null;

    const pids: VergencePIDs = {
      panX: new PID({ limits: [-SHIFT_LIMIT, SHIFT_LIMIT] }),
      panY: new PID({ limits: [-SHIFT_LIMIT, SHIFT_LIMIT] }),
      verge: new PID({
        limits: [0, distanceToVerge(VERGE_MIN_DISTANCE_MM, s.state.baseline)],
      }),
      v_shift: new PID({ limits: [-VSHIFT_LIMIT, VSHIFT_LIMIT] }),
    };

    function syncGains(t: Tuning): void {
      pids.panX.kp = pids.panY.kp = t.pan[0];
      pids.panX.ki = pids.panY.ki = t.pan[1];
      pids.panX.kd = pids.panY.kd = t.pan[2];
      pids.verge.kp = t.depth[0];
      pids.verge.ki = t.depth[1];
      pids.verge.kd = t.depth[2];
      pids.v_shift.kp = t.v_shift[0];
      pids.v_shift.ki = t.v_shift[1];
      pids.v_shift.kd = t.v_shift[2];
    }
    syncGains(s.state.tuning);

    function effectiveScale(): number {
      const zoom = Math.max(1, s.state.zoom);
      const ratio = Math.max(0, Math.min(1, s.state.tuning.scale));
      return 1 + (zoom - 1) * ratio;
    }

    function frozen(): boolean {
      if (kcf.active) return false; // actively tracking: never freeze
      const t = s.state.tuning.timeout;
      const timeoutMs = t > 0 ? t : Infinity;
      return timeoutMs !== Infinity && now() - windowStart > timeoutMs;
    }

    function clampRect(r: Rect): Rect {
      return clampRectToSize(r, { width, height });
    }

    function searchWindow(box: Rect, scale = 1): Rect {
      const px = Math.max(0, s.state.kernel.w * scale);
      const py = Math.max(0, s.state.kernel.h * scale);
      const x = Math.max(0, Math.round(box.x - px));
      const y = Math.max(0, Math.round(box.y - py));
      const right = Math.min(width, Math.round(box.x + box.width + px));
      const bottom = Math.min(height, Math.round(box.y + box.height + py));
      return clampRect({ x, y, width: right - x, height: bottom - y });
    }

    function releaseTracker(): void {
      kcf.release();
      s.telemetry({ tracker_bbox: null });
    }

    function initTracker(view: Mat<Uint8Array>, center: Point2d): void {
      const roi = clampRect(
        RECT.fromCenter(center, { width: s.state.kernel.w, height: s.state.kernel.h }),
      );
      if (roi.width <= 0 || roi.height <= 0) return;
      kcf.init(view, roi); // internally releases any previous tracker first
      lastGood = center;
      s.setState("target", center);
      s.telemetry({ tracker_bbox: roi });
    }

    // PB3 A-4: async + busy-drop (a tick arriving while the previous update is
    // still resolving is skipped — `kcf.update` no-ops reentrantly) + staleness
    // guard (a completion for a released/re-initialized tracker is discarded
    // by `tracker.ts`, never applied here).
    function updateTracker(view: Mat<Uint8Array>): void {
      void kcf.update(view).then((result) => {
        if (result.status === "tracking") {
          lastGood = result.center;
          s.setState("target", result.center);
          s.telemetry({ tracker_bbox: result.bbox });
        } else if (result.status === "lost") {
          s.setState("target", lastGood);
          s.telemetry({ tracker_bbox: null });
        }
        // "dropped" (busy/stale/sub-threshold miss): no observable change.
      });
    }

    // --- per-eye taps: wrap + tile + (for "disparity") combined view -----
    //
    // PB3 A-5: `wrapPerspective` (a full-frame remap) + the "disparity"
    // combined view's `diff` are ms-scale — previously run inline in the
    // registry's synchronous `onView` dispatch (see `@orchestrator/
    // frame-worker`'s header for why that throttles the whole camera serial).
    // Each tap now only copies the tap buffer and hands off to a busy-gated,
    // latest-wins `frameWorker`; `tileL`/`tileR` (feeding the *actuation*-
    // relevant `step()`) update at whatever cadence that settles to — already
    // tolerated, since `step()`/`analyzeVergence` are documented to run
    // against per-eye taps that don't arrive frame-synchronized in the first
    // place (see `vergence.ts`'s `getFoveaTile` doc).

    function processFoveaView(role: "L" | "R", raw: Mat<Uint8Array>): void {
      if (!triple) return;
      const A = triple.conv.V2A[role](volts[role]);
      const wrapped = wrapPerspective(raw, triple.conv.A2H[role](A)); // independent Mat
      const display = s.state.wrap ? wrapped : raw;
      s.frame(role, display);
      aligned[role] = wrapped;
      if (width && height) {
        const size = foveaTileSize({
          width,
          height,
          zoom: Math.max(1, s.state.zoom),
          scale: effectiveScale(),
        });
        void getFoveaTile(wrapped, size).then((tile) => {
          if (role === "L") tileL = tile;
          else tileR = tile;
        });
      }
      if (role === "R" && s.state.view === "disparity" && aligned.L && aligned.R) {
        s.frame("center.disparity", diff(aligned.L, aligned.R, true));
      }
    }

    // Workload meter names (A-8) — the workers (and their meters) are
    // process-lifetime: this session is a boot-time singleton and the workers
    // persist across idle/activate cycles, so `worker.dispose()` has no call
    // site on purpose (`ServerSession.dispose()` is a reusable force-idle —
    // releaseCameras, window-switch drain — not a terminal teardown;
    // disposing the meters there would inert them after the first switch).
    const foveaWorkers = {
      L: createFrameWorker<Mat<Uint8Array>, Mat<Uint8Array>>({
        name: "disparity-scope:fovea:L",
        copy: copyMat,
        process: (v) => processFoveaView("L", v),
      }),
      R: createFrameWorker<Mat<Uint8Array>, Mat<Uint8Array>>({
        name: "disparity-scope:fovea:R",
        copy: copyMat,
        process: (v) => processFoveaView("R", v),
      }),
    };

    function onFoveaView(role: "L" | "R", raw: Mat<Uint8Array>): void {
      foveaWorkers[role].submit(raw);
    }

    // --- center tap: drives the tracker + sliced view + the control step -

    async function step(c: Mat<Uint8Array>): Promise<void> {
      if (!triple || !tileL || !tileR) return;
      const analysis = await analyzeVergence({ l: tileL, r: tileR }, c, {
        width,
        height,
        zoom: Math.max(1, s.state.zoom),
        scale: effectiveScale(),
        target: s.state.target,
        expand_x: s.state.tuning.expand_x,
        expand_y: s.state.tuning.expand_y,
      });
      s.frame("guide", analysis.guide);
      s.frame("match_left", analysis.ml.mat);
      s.frame("match_right", analysis.mr.mat);
      s.telemetry({
        match_left: { rect: analysis.ml.rect, score: analysis.ml.score },
        match_right: { rect: analysis.mr.rect, score: analysis.mr.score },
        match_center: analysis.center,
      });

      const undistort = triple.undistort;
      if (!undistort) {
        status = "no calibration";
        return;
      }
      if (dragging) {
        status = "manual";
        const ray = undistort.angular([s.state.target], true)[0];
        commandedVolts = { l: triple.conv.A2V.L(ray), r: triple.conv.A2V.R(ray) };
        return;
      }
      if (frozen()) {
        status = "frozen";
        return;
      }
      const t = now();
      const dt = Math.min((t - lastStep) * s.state.tuning.sensitivity, DT_MAX_FRAMES);
      const result = stepVergence(
        analysis,
        pids,
        { P2A: triple.conv.P2A, A2V: triple.conv.A2V },
        { baseline: s.state.baseline, minScore: s.state.tuning.min_score },
        dt,
      );
      if (!result) {
        status = "low score";
        return;
      }
      lastStep = t;
      status = "tracking";
      commandedVolts = { l: result.left, r: result.right };
    }

    function onCenterView(raw: Mat<Uint8Array>): void {
      const [h, w] = raw.shape;
      if (w !== width || h !== height) {
        width = w;
        height = h;
        s.telemetry({ size: { width, height } });
      }
      if (pendingTrackerInit) {
        const c = pendingTrackerInit;
        pendingTrackerInit = null;
        initTracker(raw, c);
      } else if (kcf.active && !kcf.updating) {
        updateTracker(raw);
      }
      s.frame("C", raw);
      if (s.state.view === "sliced" && width && height) {
        const zoom = Math.max(1, s.state.zoom);
        const size = { width: width / zoom, height: height / zoom };
        const rect = clampRect(RECT.fromCenter(s.state.target, size));
        s.frame("center.sliced", slice(raw, rect));
      }
      if (stepBusy) return;
      stepBusy = true;
      void step(raw).finally(() => {
        stepBusy = false;
      });
    }

    // --- actuation (fixed-rate, decoupled from analysis fps) -------------

    function targetVolts(): { l: Pos; r: Pos } {
      return commandedVolts;
    }

    function onVolts(v: { L: Pos; R: Pos }, actuateMs: number): void {
      volts.L = v.L;
      volts.R = v.R;
      actuateMsStats.push(actuateMs);
      const t = now();
      if (t - lastVoltEmit < VOLT_TELEMETRY_INTERVAL_MS) return;
      lastVoltEmit = t;
      const vergence = triple ? triple.conv.V2A.L(v.L).x - triple.conv.V2A.R(v.R).x : 0;
      const realized_distance = vergenceToDistance(vergence, s.state.baseline / 1000);
      const commanded_distance = vergeToDistance(pids.verge.value, s.state.baseline);
      const PX = (role: "L" | "R"): Point2d =>
        triple ? triple.conv.A2P.C(triple.conv.V2A[role](v[role])) : ZERO;
      const readout: PidReadout = {
        verge: pids.verge.value,
        panX: pids.panX.value,
        panY: pids.panY.value,
        v_shift: pids.v_shift.value,
      };
      s.telemetry({
        volt: v,
        vergence,
        realized_distance,
        commanded_distance,
        L_PX: PX("L"),
        R_PX: PX("R"),
        status,
        pids: readout,
        perf: { actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max } },
      });
      actuateMsStats.resetMax();
    }

    // --- lifecycle ---------------------------------------------------------

    async function activateSession(): Promise<void> {
      const t = await acquireTriple(s);
      if (!t) return;
      triple = t;
      disposers.push(t.leases.L.onView((v) => onFoveaView("L", v)));
      disposers.push(t.leases.C.onView(onCenterView));
      publishSerials(t.leases, disposers, s);
      disposers.push(t.leases.R.onView((v) => onFoveaView("R", v)));
      loop = startActuationLoop({ targetVolts, onVolts });
      s.telemetry({ ready: true });
    }

    function idleSession(): void {
      loop?.stop();
      loop = null;
      releaseTracker();
      disposers.dispose();
      // PB3 A-5: drop anything the fovea workers still have scheduled — they
      // persist across idle/activate, so without this a frame copied just
      // before idle could be processed later against a fresh reactivation's
      // `triple` (same stale-completion class the A-4 tracker's `generation`
      // guards against).
      foveaWorkers.L.cancel();
      foveaWorkers.R.cancel();
      releaseLeases(triple);
      triple = null;
      width = height = 0;
      tileL = tileR = null;
      aligned.L = aligned.R = null;
      status = "initializing";
      commandedVolts = { l: ORIGIN_POS, r: ORIGIN_POS };
      s.resetTelemetry(["ready", "status", "tracker_bbox"]);
    }

    return {
      commands: {
        async pointer({ p, buttons: _buttons, phase }) {
          if (phase === "down") {
            releaseTracker();
            dragging = true;
          }
          if (phase !== "up") {
            s.setState("target", p);
          } else {
            dragging = false;
            windowStart = now();
            for (const pid of Object.values(pids)) pid.reset();
            if (s.state.tracker_enabled) pendingTrackerInit = s.state.target;
          }
        },
        async resetTuning() {
          s.setState("tuning", cloneTuning(DEFAULT_TUNING));
        },
        async reset_vergence() {
          for (const pid of Object.values(pids)) pid.reset();
        },
        async setPid({ dof, value }) {
          pids[dof].value = value;
        },
      },
      watch: {
        tuning(t) {
          syncGains(t);
        },
        baseline(v) {
          pids.verge.limits = [0, distanceToVerge(VERGE_MIN_DISTANCE_MM, v)];
        },
        tracker_enabled(on) {
          if (!on) releaseTracker();
          else if (!dragging) pendingTrackerInit = s.state.target;
        },
      },
      activate() {
        void activateSession();
      },
      idle: idleSession,
    };
  });
}
