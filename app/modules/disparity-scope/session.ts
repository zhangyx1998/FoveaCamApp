// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Disparity-scope session — auto-vergence, SPLIT-NODE topology per
// docs/proposals/split-disparity-nodes.md (ruled 2026-07-09). This module is
// the thin main-thread coordinator: it wires up the graph and forwards final
// results, it does not micro-manage frames.
//
//  - on activate: `acquireTriple` (calibration); advertise the THREE undistort
//    pipes (C = INTRINSIC undistort, L/R = HOMOGRAPHY undistort fed
//    `A2H∘V2A(volts)` by `startHomographyFeeder`); then compose the split
//    pipeline out of GENERAL-PURPOSE nodes:
//      · two SLICE nodes on the C undistort (the fovea crop brick, reused):
//        `slice/scope-strip` (the target-centered match strip) and
//        `slice/scope-tile` (the display center tile) — live-steered
//        (`steerCrops`) as the target/zoom move;
//      · three SCALE nodes (ruling 5 — the match kernel does NO resizing):
//        the strip's `scale/match` (reactive `ratio` = the match scale `s`)
//        and one `scale/scope-needle` per fovea (`dsize` = foveaTileSize) —
//        retuned (`retuneScalers`) when zoom/magnification/tuning change;
//      · two TEMPLATE-MATCH vision workers (`match/L`, `match/R`), each
//        reading its pre-sized needle + the shared pre-sized strip. Their
//        results carry the strip frame's crop ORIGIN, so origin +
//        rectCenter/s is an ABSOLUTE undistorted-wide position — no target
//        or drag flag ever rides a worker.
//  - the PID node (`win/disparity-scope/pid`) is the app-specific JOIN: per-
//    side results land keyed L/R and the vergence step runs when the arriving
//    side COMPLETES a pair (seq-gated, order-agnostic, ~once per strip
//    frame). `stepVergence` → `{ l, r }` volts → the controller NODE's
//    position input (push model; the MCU stream holds between updates).
//  - the KCF auto-follow runs on its OWN native thread (§3.5):
//    `createChainedTracker` on the C undistort brick. Its output drives the
//    session's target state (which steers the slice crops); the `overridden`
//    flag is SESSION-LOCAL now (`dragging`) — nothing app-specific rides the
//    reusable nodes.
//  - views: the sliced/guide views ARE the slice pipes (renderer
//    `usePipeFrame`); the L-vs-R difference AND anaglyph center views are a
//    real two-input COMPOSITE brick (`stereo/composite`, mode retuned from
//    `state.view`) chained on the two fovea undistort pipes (composite-node-
//    and-center-select-fix — the renderer DiffView canvas composite is
//    retired); only the per-side match heatmaps remain session frame channels.
//
// Pointer drag → the TRACKER's override (§3.5): down/move call
// `tk.override(p)`; the control step switches to DIRECT FOLLOW (user rulings
// 2026-07-08/09): pointer-down RESETS pan/verge/v_shift, so BOTH eyes ride
// exactly ON the raw cursor ray — parallel, vergence at INFINITY, no residual
// corrections — with no PID stepping and NO match-score gate (the pure
// `followTarget`; the match-gated loop could never follow a drag onto
// unmatched content). The pointer handler also pushes the follow volts
// synchronously so the drag doesn't lag a match tick. The all-zero controller
// state equals the follow command, so on release the tracker RE-ARMS at the
// drag end and the PID resumes continuously from the parallel pose (no seed),
// then re-converges every DOF from scratch. The PID node's own override slot
// stays for the generic `pidOverride` command; its seeded release
// (`seedFromOverride`) serves only that path.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { controllerNode, type PositionInput } from "@orchestrator/controller-node";
import { DisposerBag, publishSerials, releaseLeases } from "@orchestrator/session-resources";
import { ORIGIN_POS, radians, VOLT_TELEMETRY_INTERVAL_MS } from "@orchestrator/fovea-pipeline";
import { createVisionWorker, type VisionWorkerHandle } from "@orchestrator/vision-worker-host";
import {
  advertiseHomographyUndistortPipe,
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import {
  conversionComputeH,
  startHomographyFeeder,
} from "@orchestrator/homography-feeder";
import { pushHomography } from "core/Aravis";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { registerGraphWiring } from "@orchestrator/graph-topology";
import {
  applyPidOverride,
  createPidNode,
  outputOf,
  type PidNodeHandle,
} from "@orchestrator/pid-node";
import type { PipeBroker } from "@orchestrator/pipe-session";
import type { PipeInput, VisionResult } from "@orchestrator/vision-worker-protocol";
import {
  disparity,
  DEFAULT_TUNING,
  VERGE_MIN_DISTANCE_MM,
  SHIFT_LIMIT_DEG,
  VSHIFT_LIMIT_DEG,
  type Tuning,
  type PidReadout,
  type VergenceVolts,
} from "./contract";
import {
  followTarget,
  foveaTileSize,
  matchMagnification,
  seedVergence,
  stepVergence,
  type ScopeProjection,
  type VergenceControllers,
} from "./vergence";
import { createSlicePipe, type SliceHandle, type SlicePipeSeam } from "@orchestrator/slice-pipe";
import { createScalePipe, type ScaleHandle, type ScalePipeSeam } from "@orchestrator/scale-pipe";
import { createStereoPipe, type StereoHandle, type StereoPipeSeam } from "@orchestrator/stereo-pipe";
import { createHeatmapPipe, type HeatmapHandle, type HeatmapPipeSeam } from "@orchestrator/heatmap-pipe";
import { createCompositePipe, type CompositeHandle, type CompositePipeSeam } from "@orchestrator/composite-pipe";
import type { TemplateMatchValues } from "@orchestrator/template-match-kernel";
import { consumeTracker, createDisparityTrackerFeed } from "./tracker-feed";
import { makeMat } from "@lib/mat";
import { PID, PID2D, type PidParams } from "@lib/pid";
import { distanceToVerge, vergeToDistance, vergenceToDistance } from "@lib/stereo";
import { RollingStats } from "@lib/util/rolling";
import { RECT, VEC } from "@lib/util/geometry";
import type { Point2d, Rect, Size } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
// Direct core import in a session — an accepted precedent; all PURE logic lives
// in tracker-feed.ts/vergence.ts so vitest never loads the native addon.
import { createChainedTracker, type KcfTracker, type TrackerMeter } from "core/Tracker";
import { registerNativeProbe } from "@orchestrator/native-probes";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";

const ZERO: Point2d = { x: 0, y: 0 };
const now = () => performance.now();

const SHIFT_LIMIT = radians(SHIFT_LIMIT_DEG);
const VSHIFT_LIMIT = radians(VSHIFT_LIMIT_DEG);
const DT_MAX_FRAMES = 10;
const TRACKER_LOST_TOLERANCE = 10;
// Two matched rays are treated as parallel (verge 0, z → ∞) below this
// tan-difference — guards the seed inverse against a divide-by-~0 on the pure
// drag case (both eyes on the same ray).
const SEED_PARALLEL_EPS = 1e-9;

// Adapt the native tracker meter to the `WorkloadSnapshot` shape
// `perfSnapshot.workloads` uses — keyed by the kcf NODE id so the meter folds
// onto the graph node's badge.
function trackerWorkload(name: string, m: TrackerMeter): WorkloadSnapshot {
  const t = Date.now();
  return {
    name,
    window: { startedAt: t - m.uptimeMs, snapshotAt: t, uptimeMs: m.uptimeMs },
    utilization: m.utilization,
    busyMs: m.busyMs,
    inputs: m.inputs,
    outputs: m.outputs,
    drops: { total: m.dropTotal, ratePerSec: 0, byReason: {} },
  };
}

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

export default function disparityScopeSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
  sliceSeam: SlicePipeSeam,
  scaleSeam: ScalePipeSeam,
  stereoSeam: StereoPipeSeam,
  heatmapSeam: HeatmapPipeSeam,
  compositeSeam: CompositePipeSeam,
): ServerSession<typeof disparity> {
  return defineSession("disparity-scope", disparity, (s) => {
    let triple: CalibratedTriple | null = null;
    const disposers = new DisposerBag();
    // The controller node's position input (push-model device transport,
    // controller-node-and-fifo-edges §3) — opened on activate, closed on idle.
    let posInput: PositionInput | null = null;
    // v1 awaited-actuate round-trip ms (node `onApplied`); ~0 on v2 streaming.
    let lastActuateMs = 0;
    // The two per-side template-match workers (split-disparity-nodes).
    const workers: { L: VisionWorkerHandle | null; R: VisionWorkerHandle | null } = {
      L: null,
      R: null,
    };
    // The general-purpose bricks this session composes (created on activate,
    // retired via `disposers` on idle — consumer-most first).
    let stripSlice: SliceHandle | null = null;
    let tileSlice: SliceHandle | null = null;
    let stripScale: ScaleHandle | null = null;
    const needleScales: { L: ScaleHandle | null; R: ScaleHandle | null } = {
      L: null,
      R: null,
    };
    // SGBM disparity + heatmap (stereo-disparity-and-heatmap-nodes): composed
    // at activate but PARKED until the renderer connects the heatmap pipe
    // (ruling 2 — no subscriber → no compute; the consumer gate + the
    // heatmap→stereo tap propagate demand end to end).
    let stereo: StereoHandle | null = null;
    let stereoHeatmap: HeatmapHandle | null = null;
    // The anaglyph / L-vs-R difference COMPOSITE node (composite-node-and-
    // center-select-fix): a two-input BGRA brick chained on the same L/R
    // undistort pipes DiffView used to composite in the renderer. Parked until
    // the center view selects disparity/anaglyph (ruling 2); its mode is
    // retuned from `state.view` (`disparity` → difference, `anaglyph` →
    // anaglyph). One connected pipe replaces three per-frame canvas passes.
    let composite: CompositeHandle | null = null;
    // Wide (C) frame dims — the crop/scale geometry base (camera features,
    // read once on activate; the old kernel derived them from frames).
    let wide: Size = { width: 0, height: 0 };
    // Fovea (L/R) source frame dims — the NEEDLE scale base when the MEASURED
    // magnification drives the match (see `needleGeometry`): the measured
    // matchZoom is a fovea-px-per-center-px ratio (folds in any fovea↔center
    // RESOLUTION difference, not just the optical FOV ratio), so the fovea
    // frame's footprint in wide-px is `foveaWidth / matchZoom`. Sizing the
    // tile from the CENTER width under that zoom added an uncorrected
    // foveaRes/centerRes factor that shrank the needle on rigs where the
    // fovea cams out-resolve the center (the too-small-needle defect; was the
    // docs/applications/disparity-scope.md "Secondary (RIG-GATED)" finding).
    // The nominal-zoom FALLBACK is a pure FOV ratio and keeps the legacy
    // center-dims base. L/R share a model/resolution on the Duo, matching the
    // single mean matchZoom; read from the L lease on activate.
    let fovea: Size = { width: 0, height: 0 };
    // The match scale `s` currently commanded to the strip scaler — the
    // divisor that lifts match rects back to full-res strip-local px.
    let stripScaleFactor = 1;
    // The strip crop rect currently commanded (source/undistorted px).
    let stripRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
    // The graph-visible PID controller node (created on activate). Holds the
    // vergence controllers + the renderer-driven override slot.
    let pidNode: PidNodeHandle<VergenceVolts> | null = null;

    let windowStart = now();
    let lastStep = now();
    let lastVoltEmit = 0;
    let status = "initializing";
    let lastGood: Point2d = ZERO;

    // --- chained tracker state (§3.5) ---
    // The session-owned KCF thread on the C undistort chain (created on
    // activate, released on drain).
    let tk: KcfTracker | null = null;
    // JS-side auto-follow gate: native has NO disarm, so a "released" tracker
    // keeps emitting results and this gate ignores them until the next arm.
    let trackerArmed = false;
    // Found results currently flowing (drives `frozen()` + the bbox overlay).
    let trackerActive = false;
    // A pointer drag is in flight (down..up) — the tracker override is engaged.
    let dragging = false;
    // Last `overridden` telemetry sent (publish transitions only, not every
    // tracker result).
    let overriddenTele = false;

    // Commanded volts — the PID node's output (control result or pinned
    // override), pushed to the controller node on every result (`pushVolts`).
    let commandedVolts: VergenceVolts = { l: ORIGIN_POS, r: ORIGIN_POS };
    const actuateMsStats = new RollingStats(0.9, 2, "ms");

    // The named DOF controllers (owned by the PID node once created). `pan` is a
    // PID2D (separate x/y integrators); `verge`/`v_shift` are scalar PIDs.
    const pan = new PID2D();
    const verge = new PID({
      limits: [0, distanceToVerge(VERGE_MIN_DISTANCE_MM, s.state.baseline)],
    });
    const v_shift = new PID({ limits: [-VSHIFT_LIMIT, VSHIFT_LIMIT] });
    const controllers: VergenceControllers = { pan, verge, v_shift };

    const shiftLim: [number, number] = [-SHIFT_LIMIT, SHIFT_LIMIT];
    function panParams(t: Tuning): PidParams {
      return { kp: t.pan[0], ki: t.pan[1], kd: t.pan[2], limits: shiftLim };
    }
    /** Retune the controllers from tuning (uniform {@link PidParams}) without
     *  disturbing the running integrators — `verge`'s baseline-derived limits
     *  are left intact (setParams only touches limits when passed). */
    function syncGains(t: Tuning): void {
      pan.setParams({ x: panParams(t), y: panParams(t) });
      verge.setParams({ kp: t.depth[0], ki: t.depth[1], kd: t.depth[2] });
      v_shift.setParams({
        kp: t.v_shift[0],
        ki: t.v_shift[1],
        kd: t.v_shift[2],
        limits: [-VSHIFT_LIMIT, VSHIFT_LIMIT],
      });
    }
    syncGains(s.state.tuning);

    /** Calibration-MEASURED fovea↔wide magnification for the match (mean of
     *  the per-eye values when both are measured; a single eye's value when
     *  only one is; null when neither is — the kernel then falls back to the
     *  nominal `state.zoom`, the exact pre-measurement behavior). */
    function measuredMatchZoom(): number | null {
      if (!triple) return null;
      const { L, R } = triple.magnification;
      if (L !== null && R !== null) return (L + R) / 2;
      return L ?? R;
    }

    /** Magnification driving the tile/strip match scale (measured, else the
     *  nominal UI zoom). `state.zoom` itself now drives ONLY the sliced-view
     *  crop + KCF search sizing — see docs/applications/disparity-scope.md. */
    function matchZoom(): number {
      return matchMagnification(measuredMatchZoom(), s.state.zoom);
    }

    /** The needle scaler's zoom + BASE DIMS, paired by the zoom's units: the
     *  MEASURED magnification is a fovea-px-per-center-px ratio → divide the
     *  FOVEA source dims; the nominal fallback is a pure FOV ratio → divide
     *  the CENTER dims (the legacy `W_c/z`). Pairing either zoom with the
     *  other width injects an uncorrected foveaRes/centerRes factor (the
     *  too-small-needle defect). `matchMagnification` returns the measured
     *  value VERBATIM when it accepts it, so identity picks the branch. */
    function needleGeometry(): { zoom: number; base: Size } {
      const measured = measuredMatchZoom();
      const zoom = matchMagnification(measured, s.state.zoom);
      return { zoom, base: zoom === measured ? fovea : wide };
    }

    function effectiveScale(): number {
      const ratio = Math.max(0, Math.min(1, s.state.tuning.scale));
      return 1 + (matchZoom() - 1) * ratio;
    }

    function frozen(): boolean {
      if (trackerActive) return false; // actively tracking: never freeze
      const t = s.state.tuning.timeout;
      const timeoutMs = t > 0 ? t : Infinity;
      return timeoutMs !== Infinity && now() - windowStart > timeoutMs;
    }

    // --- crop/scale geometry (split-disparity-nodes) -----------------------
    // The session owns ALL sizing math (ruling 5): the slice nodes get crop
    // rects, the scale nodes get ratio/dsize, and the match workers stay
    // geometry-free. Steering is reactive (`setFoveaRect`/`setScaleParams`,
    // applied on the producers' next frame — no re-attach, no gate churn).

    function clampToWide(r: Rect): Rect {
      const x = Math.max(0, Math.min(r.x, wide.width));
      const y = Math.max(0, Math.min(r.y, wide.height));
      return {
        x,
        y,
        width: Math.max(1, Math.min(r.width, wide.width - x)),
        height: Math.max(1, Math.min(r.height, wide.height - y)),
      };
    }

    /** The display center tile: `wide/zoom`, target-centered (the same crop
     *  the old kernel's "sliced" view cut). */
    function tileRect(): Rect {
      const z = Math.max(1, s.state.zoom);
      return clampToWide(
        RECT.fromCenter(s.state.target, {
          width: wide.width / z,
          height: wide.height / z,
        }),
      );
    }

    /** The match strip: the center tile expanded by `expand_x`/`expand_y`,
     *  target-centered (the guide strip `analyzeVergence` used to cut). */
    function computeStripRect(): Rect {
      const z = Math.max(1, s.state.zoom);
      const t = s.state.tuning;
      return clampToWide(
        RECT.fromCenter(s.state.target, {
          width: (wide.width / z) * t.expand_x,
          height: (wide.height / z) * t.expand_y,
        }),
      );
    }

    /** Re-steer both slice crops to the current target/zoom/expansion. */
    function steerCrops(): void {
      if (!wide.width) return;
      tileSlice?.steer(tileRect());
      stripRect = computeStripRect();
      stripSlice?.steer(stripRect);
    }

    /** Retune the three scale nodes: strip ratio = the match scale `s` (both
     *  sides land at `s` px per wide px — CCOEFF matching is not scale-
     *  invariant), needles to the fovea's wide-frame footprint at `s`. */
    function retuneScalers(): void {
      if (!wide.width) return;
      const sF = effectiveScale();
      stripScaleFactor = sF;
      stripScale?.retune({ ratio: sF });
      const g = needleGeometry();
      const size = foveaTileSize({
        width: g.base.width,
        height: g.base.height,
        zoom: g.zoom,
        scale: sF,
      });
      const dsize = {
        width: Math.max(1, Math.round(size.width)),
        height: Math.max(1, Math.round(size.height)),
      };
      needleScales.L?.retune({ dsize });
      needleScales.R?.retune({ dsize });
    }

    /** Retune the composite brick's mode from the selected center view:
     *  `disparity` → the L-vs-R difference, `anaglyph` → the anaglyph. Other
     *  views leave the mode alone (the node is parked anyway — no consumer). */
    function syncCompositeMode(view: string): void {
      if (view === "disparity") composite?.retune({ mode: "difference" });
      else if (view === "anaglyph") composite?.retune({ mode: "anaglyph" });
    }

    // --- chained tracker (§3.5): arm + result feed -------------------------

    /** Publish the `overridden` telemetry on TRANSITIONS only (the tracker
     *  re-affirms the flag every frame; the UI badge needs edges, not spam). */
    function publishOverridden(v: boolean): void {
      if (v === overriddenTele) return;
      overriddenTele = v;
      s.telemetry({ overridden: v });
    }

    /** (Re-)arm the chained tracker at `center` with the contract's KCF
     *  template size. Native clamps the ROI to the frame. */
    function armTracker(center: Point2d): void {
      if (!tk) return;
      tk.arm(
        RECT.fromCenter(center, {
          width: s.state.kernel.w,
          height: s.state.kernel.h,
        }),
      );
      trackerArmed = true;
    }

    // Per-result routing off the tracker thread (pure reducer — see
    // tracker-feed.ts for the gating/tolerance semantics). Every path forwards
    // the scalar target + the override flag to the KERNEL, which carries it
    // onto `projection.overridden` for the PID step.
    const trackerFeed = createDisparityTrackerFeed(
      {
        armed: () => trackerArmed,
        onDrag(center) {
          // Drag in flight: the tracker echoes the override point every frame.
          // The pointer handler already pushed it synchronously; this keeps
          // target+crops+follow coherent at FRAME rate even if a pointer move
          // was coalesced away (the match-rate join path is slower).
          lastGood = center;
          s.setState("target", center);
          steerCrops();
          publishOverridden(true);
          const v = followVolts(center);
          if (v && !pidNode?.override.engaged) {
            commandedVolts = v;
            pushVolts();
          }
        },
        onTrack(center, bbox) {
          trackerActive = true;
          lastGood = center;
          s.setState("target", center);
          steerCrops();
          s.telemetry({ tracker_bbox: bbox });
          publishOverridden(false);
        },
        onLost() {
          // Tolerance exceeded: release auto-follow (JS gate), hold the last
          // good target — the same policy the old in-kernel tracker had.
          trackerArmed = false;
          trackerActive = false;
          s.setState("target", lastGood);
          s.telemetry({ tracker_bbox: null });
        },
      },
      TRACKER_LOST_TOLERANCE,
    );

    // --- PID-node override slot (generic volts path ONLY since §3.5) --------

    /** Mirror the server-authoritative override slot into contract state so the
     *  renderer's `usePidOverride` proxy reads `engaged`/`value` back. */
    function publishOverride(): void {
      s.setState(
        "pidOverride",
        pidNode
          ? { engaged: pidNode.override.engaged, value: pidNode.override.value }
          : { engaged: false, value: null },
      );
    }

    /**
     * Reseed the controllers from the LAST override value so control resumes
     * CONTINUOUSLY (velocity-form integrator ⇒ output = last command = no jump).
     * Invoked by `override.release()`; the reconstruction inverse lives in the
     * pure {@link seedVergence} (see its SPACE CONTRACT).
     *
     * GENERIC volts path only since §3.5: pointer drags ride the TRACKER
     * override (the PID keeps running — nothing pins, nothing seeds), so the
     * slot is only ever engaged by the `pidOverride` command with arbitrary
     * per-eye volts that genuinely encode a vergence. Those are recovered
     * through V2A (per-eye lossy round-trip accepted — there is no shared ray
     * to seed from on this path).
     */
    function seedFromOverride(v: VergenceVolts): void {
      if (!triple || !triple.undistort) return;
      const conv = triple.conv;
      const gL = conv.V2A.L(v.l);
      const gR = conv.V2A.R(v.r);
      const aT = conv.P2A.C(s.state.target, false);
      const seed = seedVergence(gL, gR, aT, s.state.baseline, SEED_PARALLEL_EPS);
      pan.value = seed.pan; // PID2D setter clamps each axis to its limits
      verge.value = seed.verge; // PID setter clamps to its limits
      v_shift.value = seed.v_shift; // PID setter clamps to its limits
    }

    // --- per-side match results → the pid JOIN (split-disparity-nodes) -----

    type SideKey = "L" | "R";
    type SideMatch = { center: Point2d; score: number; seq: number };
    // Latest result per side; the vergence step runs when the ARRIVING side
    // completes a pair (its seq >= the other side's latest) — order-agnostic,
    // ~once per strip frame, degrades gracefully to the slower side's rate.
    const latestMatch: { L: SideMatch | null; R: SideMatch | null } = {
      L: null,
      R: null,
    };

    function onMatch(side: SideKey, r: VisionResult): void {
      const v = r.values as unknown as TemplateMatchValues;
      // Meter the pid node's per-port arrival (edge rx — the graph's
      // match → pid rates; the join/step below is unchanged).
      pidNode?.ingest(side === "L" ? "l" : "r");
      // The correlation heatmap → this side's session frame channel.
      for (const f of r.frames)
        if (f.name === "match")
          s.frame(
            side === "L" ? "match_left" : "match_right",
            makeMat(new Uint8Array(f.buffer), [f.height, f.width], f.channels),
          );
      // Lift out of the scaled-strip space: /s → full-res strip-local px
      // (what the guide-strip overlay draws), + the frame's forwarded crop
      // origin → ABSOLUTE undistorted-wide px (what the control law reads).
      const sF = stripScaleFactor > 0 ? stripScaleFactor : 1;
      const rectFull = VEC.mul(v.rect, 1 / sF);
      const c = RECT.getCenter(rectFull);
      const m: SideMatch = {
        center: { x: v.origin.x + c.x, y: v.origin.y + c.y },
        score: v.score,
        seq: v.seq ?? 0,
      };
      latestMatch[side] = m;
      s.telemetry(
        side === "L"
          ? { match_left: { rect: rectFull, score: v.score } }
          : { match_right: { rect: rectFull, score: v.score } },
      );
      const other = latestMatch[side === "L" ? "R" : "L"];
      if (!other || m.seq < other.seq) return; // pair incomplete — wait
      // Center-tile marker for the guide overlay (strip-local full-res px,
      // anchored to THIS strip frame's origin so it stays aligned mid-steer).
      const z = Math.max(1, s.state.zoom);
      s.telemetry({
        match_center: {
          rect: RECT.fromCenter(VEC.sub(s.state.target, v.origin), {
            width: wide.width / z,
            height: wide.height / z,
          }),
        },
      });
      runControl({
        l: (side === "L" ? m : other).center,
        r: (side === "R" ? m : other).center,
        target: s.state.target,
        scores: {
          l: (side === "L" ? m : other).score,
          r: (side === "R" ? m : other).score,
        },
        // SESSION-LOCAL now (split-disparity-nodes): the drag flag never rides
        // a reusable node — the pointer handler owns `dragging` directly, so
        // the old one-kernel-tick flag lag is gone too.
        overridden: dragging,
      });
    }

    /** Direct-follow volts for `target` (the drag path — see
     *  {@link followTarget} for why the match gate must not apply): the plain
     *  reconstruction of the CURRENT controller state at the dragged target.
     *  Pointer-down RESETS pan/verge/v_shift (user ruling 2026-07-09), so
     *  during a drag this puts BOTH eyes exactly ON the raw cursor ray —
     *  parallel, vergence at infinity, no residual corrections — and the
     *  controllers equal the command (all zero) throughout, which is what
     *  makes the release resume the PID continuously (velocity-form:
     *  value == command). Null without a calibrated triple (nothing can
     *  lift pixels to angles — same degradation as the control law). */
    function followVolts(target: Point2d): VergenceVolts | null {
      if (!triple || !triple.undistort) return null;
      const r = followTarget(
        target,
        { pan: pan.value, verge: verge.value, v_shift: v_shift.value },
        { P2A: triple.conv.P2A, A2V: triple.conv.A2V },
        s.state.baseline,
      );
      return { l: r.left, r: r.right };
    }

    /** The vergence control law, run INSIDE the PID node's control fn — invoked
     *  by `node.step` only when the (generic) override is NOT engaged (the node
     *  resets the controllers itself while overridden). Returns the held/last
     *  volts on any hold condition so the actuation output freezes rather than
     *  winds down.
     *
     *  §3.5 "act correspondingly" on `projection.overridden` (a tracker-override
     *  drag riding the projection): DIRECT FOLLOW (user rulings 2026-07-08/09)
     *  — both eyes track the dragged target exactly on the raw cursor ray,
     *  parallel, vergence at INFINITY (`followVolts`; pan/verge/v_shift were
     *  RESET at pointer-down); the PID does NOT step and the match-score gate
     *  does NOT apply (a drag onto unmatched content must still move the
     *  foveas). The freeze window is held open (a drag is user activity; a
     *  long drag must not hit the convergence timeout mid-gesture) and status
     *  reads "manual" so the UI shows the drag. The all-zero controller state
     *  equals the command, so the release resumes the PID continuously from
     *  the parallel pose (no seed — see the header). */
    function controlStep(projection: ScopeProjection): VergenceVolts {
      if (!triple || !triple.undistort) {
        status = "no calibration";
        return commandedVolts;
      }
      if (projection.overridden) {
        windowStart = now(); // drag = activity
        status = "manual";
        // Kernel-rate re-affirmation of the drag follow (the pointer handler
        // already pushed synchronously; this keeps the output tracking a
        // coalesced-away pointer move and any target clamp the kernel applied).
        return followVolts(projection.target) ?? commandedVolts;
      }
      if (frozen()) {
        status = "frozen";
        return commandedVolts;
      }
      const t = now();
      const dt = Math.min((t - lastStep) * s.state.tuning.sensitivity, DT_MAX_FRAMES);
      const result = stepVergence(
        projection,
        controllers,
        { P2A: triple.conv.P2A, A2V: triple.conv.A2V },
        { baseline: s.state.baseline, minScore: s.state.tuning.min_score },
        dt,
      );
      if (!result) {
        status = "low score";
        return commandedVolts;
      }
      lastStep = t;
      status = "tracking";
      return { l: result.left, r: result.right };
    }

    function runControl(projection: ScopeProjection): void {
      if (!pidNode) return;
      commandedVolts = outputOf(pidNode.step(() => controlStep(projection)));
      if (pidNode.override.engaged) status = "manual";
      pushVolts();
    }

    // --- actuation (push-model: at the projection/PID result rate) --------

    /** Push the current command to the controller node's position input; the
     *  MCU stream holds it between pushes (a hold path returning the last
     *  volts re-pushes the same value — the `StreamUpdateGate` dedupes it).
     *  `update()`'s synchronous predicted-volt return feeds the volt telemetry
     *  the old loop's `onVolts` carried. */
    function pushVolts(): void {
      if (!posInput) return;
      const p = posInput.update({ left: commandedVolts.l, right: commandedVolts.r });
      onVolts({ L: p.left, R: p.right }, lastActuateMs);
    }

    function onVolts(vv: { L: Pos; R: Pos }, actuateMs: number): void {
      actuateMsStats.push(actuateMs);
      const t = now();
      if (t - lastVoltEmit < VOLT_TELEMETRY_INTERVAL_MS) return;
      lastVoltEmit = t;
      const vergence = triple ? triple.conv.V2A.L(vv.L).x - triple.conv.V2A.R(vv.R).x : 0;
      const realized_distance = vergenceToDistance(vergence, s.state.baseline / 1000);
      const commanded_distance = vergeToDistance(verge.value, s.state.baseline);
      // The per-eye pose overlay draws over the UNDISTORTED wide view now, so
      // project to undistorted pixels (distort=false), matching every other
      // overlay's space (target/tracker/match all undistorted).
      const PX = (role: "L" | "R"): Point2d =>
        triple ? triple.conv.A2P.C(triple.conv.V2A[role](vv[role]), false) : ZERO;
      const readout: PidReadout = {
        verge: verge.value,
        panX: pan.value.x,
        panY: pan.value.y,
        v_shift: v_shift.value,
      };
      s.telemetry({
        volt: vv,
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

    // --- lifecycle --------------------------------------------------------

    /** Connect a pipe by id (refcount++ → C-21 gate) and return its worker
     *  `PipeInput` under `role`; registers the matching `disconnect` on
     *  `disposers`. Connecting the same pipe twice (the shared strip) is
     *  fine — refcounted, two disconnects. */
    function connectPipe(role: string, pipeId: string): PipeInput {
      const handle = broker.connect(pipeId);
      disposers.add(() => broker.disconnect(pipeId));
      const { width, height, channels, bytesPerFrame, maxBytes } = handle.spec;
      return {
        role,
        shmName: handle.shmName,
        width,
        height,
        channels,
        bytesPerFrame: maxBytes ?? bytesPerFrame,
      };
    }

    async function activateSession(): Promise<void> {
      const t = await acquireTriple(s);
      if (!t) return;
      triple = t;
      publishSerials(t.leases, disposers, s);

      // §5 view re-plumb: advertise the three undistort pipes the views + the
      // scope kernel source from. C = INTRINSIC undistort (cal = the SAME
      // record the triple's `undistort` was built from — `triple.undistort`
      // was constructed from it). L/R (mirror-steered) = HOMOGRAPHY undistort,
      // each fed `A2H∘V2A(volts)` from the mirror history by a feeder (an empty
      // ring passes frames through). The PRODUCER teardown is deferred AFTER
      // the consumer `disconnect`s (DisposerBag is FIFO) — retirers are added
      // once the kernel inputs are connected.
      const undistortIds: Record<"L" | "C" | "R", string | null> = {
        L: null,
        C: null,
        R: null,
      };
      const retirers: (() => void)[] = [];
      if (t.undistort) {
        const idC = advertiseUndistortPipe(
          undistortSeam,
          t.leases.C.camera,
          t.undistort.calibration,
        );
        undistortIds.C = idC;
        retirers.push(() => retireUndistortPipe(undistortSeam, idC));
      }
      const computeH = conversionComputeH(t.conv);
      for (const side of ["L", "R"] as const) {
        const pipeId = advertiseHomographyUndistortPipe(
          undistortSeam,
          t.leases[side].camera,
        );
        undistortIds[side] = pipeId;
        const stopFeeder = startHomographyFeeder({
          pipeId,
          side,
          computeH,
          push: pushHomography,
        });
        retirers.push(() => {
          stopFeeder(); // stop pushing BEFORE the brick detaches
          retireUndistortPipe(undistortSeam, pipeId);
        });
      }

      // Split pipeline (split-disparity-nodes, ruled 2026-07-09): compose the
      // GENERAL-PURPOSE bricks — slice (fovea crop) → scale → template-match
      // ×2 — on the C source. C falls back to the raw convert pipe on an
      // uncalibrated wide camera (control then holds "no calibration", the
      // same degradation as before).
      const serialC = t.leases.C.camera.serial;
      const cSourceId = undistortIds.C ?? nodeId.convert(serialC);
      const camC = t.leases.C.camera;
      wide = {
        width: camC.getFeatureInt("Width"),
        height: camC.getFeatureInt("Height"),
      };
      // Fovea source dims for the needle scale base (see the `fovea` decl):
      // read from L; L/R share a model/resolution on the Duo (the same single-
      // eye assumption the mean `matchZoom` already bakes in).
      fovea = {
        width: t.leases.L.camera.getFeatureInt("Width"),
        height: t.leases.L.camera.getFeatureInt("Height"),
      };
      s.telemetry({ size: { ...wide } }); // was the old kernel's `values.size`

      // SLICE nodes: the match strip + the display center tile, both crops of
      // the C source, live-steered by `steerCrops`. Max footprint = the full
      // frame (zoom → 1 legally grows either crop to the whole frame).
      stripRect = computeStripRect();
      stripSlice = createSlicePipe(
        sliceSeam,
        cSourceId,
        nodeId.slice(serialC, "scope-strip"),
        { rect: stripRect, maxWidth: wide.width, maxHeight: wide.height },
      );
      tileSlice = createSlicePipe(
        sliceSeam,
        cSourceId,
        nodeId.slice(serialC, "scope-tile"),
        { rect: tileRect(), maxWidth: wide.width, maxHeight: wide.height },
      );

      // SCALE nodes (ruling 5 — the match workers do NO resizing): the strip
      // at ratio `s` (UPSAMPLED to `s` px per wide px, meeting the demagnified
      // fovea tiles at the same pixel scale) and one needle per fovea at the
      // tile dsize. Strip max = 2× the frame; extreme zoom/expansion settings
      // clamp natively rather than over-allocate the ring.
      stripScaleFactor = effectiveScale();
      stripScale = createScalePipe(
        scaleSeam,
        stripSlice.pipeId,
        nodeId.scale(stripSlice.pipeId, "match"),
        {
          params: { ratio: stripScaleFactor },
          maxWidth: wide.width * 2,
          maxHeight: wide.height * 2,
        },
      );
      const g0 = needleGeometry();
      const tile0 = foveaTileSize({
        width: g0.base.width,
        height: g0.base.height,
        zoom: g0.zoom,
        scale: stripScaleFactor,
      });
      const dsize0 = {
        width: Math.max(1, Math.round(tile0.width)),
        height: Math.max(1, Math.round(tile0.height)),
      };
      const needleSources: Record<"L" | "R", string> = {
        L: undistortIds.L ?? nodeId.convert(t.leases.L.camera.serial),
        R: undistortIds.R ?? nodeId.convert(t.leases.R.camera.serial),
      };
      for (const side of ["L", "R"] as const) {
        const cam = t.leases[side].camera;
        needleScales[side] = createScalePipe(
          scaleSeam,
          needleSources[side],
          nodeId.scale(needleSources[side], "scope-needle"),
          {
            params: { dsize: dsize0 },
            maxWidth: cam.getFeatureInt("Width"),
            maxHeight: cam.getFeatureInt("Height"),
          },
        );
      }

      // STEREO SGBM + HEATMAP (stereo-disparity-and-heatmap-nodes): the
      // center view's "SGBM Disparity" option. Chained on the same L/R
      // pre-warped sources the needles read; the renderer binds ONLY the
      // heatmap pipe — until it connects (view selected), the consumer gate
      // keeps BOTH bricks parked and the SGBM cost is zero (ruling 2).
      // Disparity is left-frame-sized; the heatmap ring matches it.
      const camL = t.leases.L.camera;
      const stereoDims = {
        maxWidth: camL.getFeatureInt("Width"),
        maxHeight: camL.getFeatureInt("Height"),
      };
      stereo = createStereoPipe(
        stereoSeam,
        needleSources.L,
        needleSources.R,
        nodeId.stereo("scope"),
        stereoDims,
      );
      stereoHeatmap = createHeatmapPipe(
        heatmapSeam,
        stereo.pipeId,
        nodeId.heatmap(stereo.pipeId, "view"),
        stereoDims,
      );

      // COMPOSITE (composite-node-and-center-select-fix): the center view's
      // "Disparity (L v.s. R)" and "Anaglyph" options — the two-input BGRA
      // brick that REPLACES the renderer's DiffView canvas composite. Chained
      // on the SAME L/R undistort pipes DiffView consumed (`needleSources`).
      // Parked until the renderer connects it (view selected); the mode is
      // retuned from `state.view` below (initial sync covers activate on an
      // already-selected disparity/anaglyph view).
      composite = createCompositePipe(
        compositeSeam,
        needleSources.L,
        needleSources.R,
        nodeId.stereo("composite"),
        stereoDims,
      );
      syncCompositeMode(s.state.view);

      // Worker inputs: each match worker reads its pre-sized needle + the
      // SHARED pre-sized strip (refcount++ per connect — demand propagation
      // keeps the whole slice/scale/undistort chain awake while they read).
      const matchInputs: Record<"L" | "R", PipeInput[]> = {
        L: [
          connectPipe("needle", needleScales.L!.pipeId),
          connectPipe("haystack", stripScale.pipeId),
        ],
        R: [
          connectPipe("needle", needleScales.R!.pipeId),
          connectPipe("haystack", stripScale.pipeId),
        ],
      };

      // §3.5: the chained KCF tracker — its OWN native thread, tapping the
      // SAME C brick the kernel reads (undistort; convert fallback), so it
      // tracks exactly what the matcher sees. Resolved by PIPE id (the brick
      // was just advertised); the tap keeps the brick awake independent of
      // SHM consumers (same demand rule as the §5 chain). Its disposer is
      // added HERE — after the pipe disconnects, BEFORE the producer retirers
      // (DisposerBag is FIFO) — so the tap detaches before the brick dies.
      const kcfId = nodeId.undistortKcf(serialC);
      try {
        tk = createChainedTracker(cSourceId, kcfId);
      } catch (e) {
        // No brick on the pipe (shouldn't happen post-advertise) — degrade to
        // pointer-only targeting, same UX as tracker-disabled.
        console.error("[disparity-scope] chained tracker unavailable:", e);
        tk = null;
      }
      if (tk) {
        disposers.add(() => {
          tk?.release(); // closes the async iterator → consumeTracker exits
          tk = null;
          trackerArmed = false;
          trackerActive = false;
        });
        void consumeTracker(tk, trackerFeed);
      }

      // Producer teardown, consumer-most first (DisposerBag is FIFO; the pipe
      // disconnects + tracker release above run before these): scalers
      // (chained on slices/undistorts) → slices (chained on the C source) →
      // the undistort bricks + homography feeders.
      disposers.add(() => {
        stripScale?.retire();
        stripScale = null;
        needleScales.L?.retire();
        needleScales.R?.retire();
        needleScales.L = needleScales.R = null;
      });
      disposers.add(() => {
        stripSlice?.retire();
        tileSlice?.retire();
        stripSlice = tileSlice = null;
      });
      // Heatmap chains on stereo, stereo on the undistorts; composite chains
      // on the undistorts directly — retire all three before the undistort
      // retirers below.
      disposers.add(() => {
        stereoHeatmap?.retire();
        stereoHeatmap = null;
        stereo?.retire();
        stereo = null;
        composite?.retire();
        composite = null;
      });
      for (const retire of retirers) disposers.add(retire);

      const pidId = nodeId.win("disparity-scope", "pid");
      const bgra = { kind: "frame", pixelFormat: "BGRA8", dtype: "U8" } as const;
      const analysis = { kind: "analysis", schema: "template-match" } as const;
      const matchIds = {
        L: nodeId.win("disparity-scope", "match", "L"),
        R: nodeId.win("disparity-scope", "match", "R"),
      } as const;
      // Two GENERIC match workers — meterName = the node id, so each worker's
      // self-meter folds onto its own graph node badge (per-side match cost
      // is now individually visible; the monolithic kernel hid the split).
      for (const side of ["L", "R"] as const) {
        workers[side] = createVisionWorker(
          {
            pipes: matchInputs[side],
            params: { kind: "template-match" },
            meterName: matchIds[side],
          },
          (r) => onMatch(side, r),
        );
      }
      disposers.add(
        registerGraphWiring({
          nodes: [
            ...(["L", "R"] as const).map((side) => ({
              id: matchIds[side],
              kind: "template-match",
              owner: "win/disparity-scope",
              output: analysis,
              transport: "worker" as const,
            })),
            // The chained tracker does NOT self-report topology (no row from
            // native Topology.report() — unlike undistort bricks), so the
            // session registers it: C source → kcf (frames, native tap); its
            // kcf → pid target edge rides the pid node's inputs below.
            ...(tk
              ? [
                  {
                    id: kcfId,
                    kind: "kcf",
                    owner: "win/disparity-scope",
                    output: { kind: "track" } as const,
                    transport: "native" as const,
                  },
                ]
              : []),
          ],
          edges: [
            ...(["L", "R"] as const).flatMap((side) => [
              {
                from: needleScales[side]!.pipeId,
                to: matchIds[side],
                port: "needle",
                type: bgra,
              },
              {
                from: stripScale!.pipeId,
                to: matchIds[side],
                port: "haystack",
                type: bgra,
              },
            ]),
            ...(tk ? [{ from: cSourceId, to: kcfId, port: "C", type: bgra }] : []),
          ],
        }),
      );
      // The tracker self-meters under the kcf node id — probe it out-of-loop
      // so utilization/rate/drops fold onto the node's badge.
      if (tk) {
        disposers.add(
          registerNativeProbe(
            (): Record<string, WorkloadSnapshot> =>
              tk ? { [kcfId]: trackerWorkload(kcfId, tk.probe()) } : {},
          ),
        );
      }

      // The PID controller node — the app-specific JOIN (split-disparity-
      // nodes ruling 4): both match sides + the tracker's target feed
      // converge here; pid → controller carries the position-stream output.
      // `createPidNode` owns its own graph registration; dispose retires it.
      pidNode = createPidNode<VergenceVolts>({
        id: pidId,
        kind: "pid",
        owner: "win/disparity-scope",
        inputs: [
          { from: matchIds.L, port: "l" },
          { from: matchIds.R, port: "r" },
          ...(tk ? [{ from: kcfId, port: "target" }] : []),
        ],
        outputs: [{ to: nodeId.controller(), port: "volt" }],
        controllers: { pan, verge, v_shift },
        seed: seedFromOverride,
      });
      disposers.add(() => {
        pidNode?.dispose();
        pidNode = null;
      });

      // Open the controller-node position input (was `startActuationLoop`).
      // The PID node's `pid → controller` output edge above already covers the
      // topology, so `from` is omitted (no duplicate edge). The immediate push
      // reproduces the old loop's first tick: enable + drive to the current
      // command (origin) so the mirrors are parked before the first projection.
      posInput = controllerNode().openPosition("disparity-scope", {
        initial: { left: commandedVolts.l, right: commandedVolts.r },
        onApplied: (_v, actuateMs) => {
          lastActuateMs = actuateMs;
        },
      });
      pushVolts();
      // Auto-follow was left on: arm the fresh tracker at the current target.
      if (s.state.tracker_enabled) armTracker(s.state.target);
      // Surface the measured magnification (null = nominal-zoom fallback) so
      // the UI can display the actual match scale instead of guessing from
      // the (now crop-only) zoom knob.
      s.telemetry({ ready: true, match_magnification: measuredMatchZoom() });
    }

    function idleSession(): void {
      // Stop actuating FIRST (as the old loop stop did): terminate the MCU
      // stream + disable iff the node enabled for us (fire-and-forget close).
      void posInput?.close();
      posInput = null;
      // Terminate both match workers before disconnect: no reads after the
      // gate drops.
      workers.L?.terminate();
      workers.R?.terminate();
      workers.L = workers.R = null;
      latestMatch.L = latestMatch.R = null;
      trackerActive = false;
      dragging = false;
      overriddenTele = false;
      // Disconnect pipes, release tracker, retire scalers → slices →
      // undistort bricks, dispose pid node (FIFO — see activate).
      disposers.dispose();
      publishOverride(); // pidNode is now null → released state
      releaseLeases(triple);
      triple = null;
      status = "initializing";
      wide = { width: 0, height: 0 };
      fovea = { width: 0, height: 0 };
      stripScaleFactor = 1;
      commandedVolts = { l: ORIGIN_POS, r: ORIGIN_POS };
      s.resetTelemetry([
        "ready",
        "status",
        "tracker_bbox",
        "match_magnification",
        "overridden",
      ]);
    }

    return {
      commands: {
        async pointer({ p, buttons: _buttons, phase }) {
          // §3.5 drag semantics (direct-follow ruling 2026-07-08): down/move
          // engage the TRACKER's override AND directly drive the foveas to
          // the cursor ray (`followVolts` — no PID stepping, no match gate).
          // `overridden` is SESSION-LOCAL (`dragging`) since the node split —
          // the join stamps it onto each projection, so the control step
          // re-affirms the follow at match rate.
          if (phase !== "up") {
            if (phase === "down") {
              dragging = true;
              trackerActive = false;
              s.telemetry({ tracker_bbox: null });
              // Drag start RESETS the controllers (user ruling 2026-07-09):
              // pan and v_shift corrections clear along with verge, so the
              // follow puts both eyes exactly ON the raw cursor ray (parallel,
              // vergence at infinity) and release re-converges every DOF from
              // scratch. All-zero state == the follow command, so the release
              // stays continuous (velocity-form integrator = command).
              pan.reset();
              verge.reset();
              v_shift.reset();
            }
            tk?.override(p);
            // Steer synchronously too (don't wait one tracker frame) — the
            // feed re-affirms the same target at result rate.
            lastGood = p;
            s.setState("target", p);
            steerCrops();
            publishOverridden(true);
            status = "manual";
            // Refresh the freeze window NOW (`dragging` reaches the join one
            // match tick late — a drag started while frozen must servo
            // immediately).
            windowStart = now();
            // Direct follow NOW (same immediate-apply precedent as the
            // pidOverride command): the join path re-affirms at match rate.
            // Skipped while the generic PID override pins the output — that
            // slot outranks the drag, matching `node.step`'s semantics.
            const v = followVolts(p);
            if (v && !pidNode?.override.engaged) {
              commandedVolts = v;
              pushVolts();
            }
          } else {
            dragging = false;
            windowStart = now(); // drag end restarts the convergence window
            publishOverridden(false);
            if (tk) {
              // Native releaseOverride RE-ARMS KCF at the drag end on the next
              // frame; the PID resumes seamlessly (no seed — the controllers
              // held their values through the direct follow, so the first
              // resumed step's output equals the last follow output). With
              // auto-follow OFF the JS gate ignores the re-armed tracker's
              // results (native has no disarm).
              tk.releaseOverride();
              trackerArmed = s.state.tracker_enabled;
              trackerActive = false;
            }
          }
        },
        async resetTuning() {
          s.setState("tuning", cloneTuning(DEFAULT_TUNING));
        },
        async reset_vergence() {
          pan.reset();
          verge.reset();
          v_shift.reset();
        },
        async setPid({ dof, value }) {
          switch (dof) {
            case "verge":
              verge.value = value;
              break;
            case "v_shift":
              v_shift.value = value;
              break;
            case "panX":
              pan.x.value = value;
              break;
            case "panY":
              pan.y.value = value;
              break;
          }
        },
        async pidOverride(command) {
          if (!pidNode) return;
          const state = applyPidOverride(pidNode.override, command);
          if (state.engaged && state.value) {
            commandedVolts = state.value;
            status = "manual";
            // Apply immediately (the old 1 ms loop picked this up within a
            // tick) — don't wait for the next projection to push it.
            pushVolts();
          } else if (!state.engaged) {
            windowStart = now(); // released via the generic path → restart freeze window
          }
          s.setState("pidOverride", state);
        },
      },
      watch: {
        tuning(t) {
          syncGains(t);
          // Expansion re-shapes the strip crop; scale retunes the scalers.
          steerCrops();
          retuneScalers();
        },
        baseline(v) {
          verge.limits = [0, distanceToVerge(VERGE_MIN_DISTANCE_MM, v)];
        },
        zoom() {
          // Zoom re-shapes both crops AND the tile/strip scale geometry.
          steerCrops();
          retuneScalers();
        },
        // `view` now drives the composite brick's MODE server-side (composite-
        // node-and-center-select-fix): disparity → difference, anaglyph →
        // anaglyph. `sliced`/`sgbm` leave the mode alone (composite parked —
        // the renderer connects the composite pipe only for the disparity/
        // anaglyph options, so demand + mode are coherent).
        view(v) {
          syncCompositeMode(v);
        },
        kernel() {
          // The template size feeds the session-side arm ROI now (the kernel
          // runs no KCF — no params to push). Re-arm live at the current
          // target so the knob takes effect immediately — unless a drag is in
          // flight (its release re-arms anyway).
          if (trackerArmed && !dragging) armTracker(s.state.target);
        },
        tracker_enabled(on) {
          if (!on) {
            trackerArmed = false; // JS gate: results ignored (no native disarm)
            trackerActive = false;
            s.telemetry({ tracker_bbox: null });
          } else if (!dragging) {
            armTracker(s.state.target);
          }
          // While dragging, the pointer-up releaseOverride re-arms and
          // `trackerArmed` follows the (fresh) tracker_enabled state there.
        },
      },
      activate() {
        void activateSession();
      },
      idle: idleSession,
    };
  });
}
