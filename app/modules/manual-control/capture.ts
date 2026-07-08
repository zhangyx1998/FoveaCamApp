// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Server-side capture, ported from `src/capture/index.ts`'s `Capture` class +
// manual-control's `captureFoveaPair`/`normalizeFovea` (docs/history/refactor/
// orchestrator.md roadmap item 6 — raw sensor frames never cross the process
// boundary). Stacks/wraps/diffs raw L/R frames and slices the current
// undistorted center view at full (16-bit BGRA) quality, held in-memory
// (`pending`) until `save()`/`discard()`; a downconverted (8-bit BGRA) copy of
// each image resource is published as an ordinary frame payload so the
// renderer can preview before committing to disk — the *same* `FrameView.vue`
// downconversion every other preview already goes through, just relocated
// here since a non-Uint8Array Mat can't cross via `FramePayload`.
//
// Resource accumulation mirrors `Capture.capture()`'s exact semantics: "wide"
// is captured once, always a single (non-indexed) resource; every other
// resource is captured once per entry in `setpoints` (or once, unindexed, if
// `setpoints` is empty) — indexed resources accumulate as arrays, exactly
// matching the original renderer behavior for the set-points capture loop.

import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import { Vision } from "core";
import {
  convertType,
  cvtColor,
  diff,
  slice,
  wrapPerspective,
  type Mat,
} from "core/Vision";
import type { Point2d, Size } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import type { Serializable } from "@lib/orchestrator/protocol";
import { stack, makeBGRA } from "@lib/imgproc";
import { matToArray } from "@lib/mat";
import { createQMatrix, deriveFoveaIntrinsics } from "@lib/stereo";
import { RECT } from "@lib/util/geometry";
import type { CalibratedTriple } from "@orchestrator/calibration";
import type { SessionFrameSource } from "@orchestrator/frame-transport";
import type { VoltPreviewQuery } from "./contract";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mirrors `src/capture/index.ts`'s `RGB2BGR` verbatim — the save pipeline
// expects BGR-ordered data; keep the exact existing behavior, not a redesign.
function RGB2BGR(image: Mat) {
  switch (image.channels) {
    case 4:
      return cvtColor(image, "RGBA2BGRA");
    case 3:
      return cvtColor(image, "RGB2BGR");
    default:
      return image;
  }
}

function clampRect(r: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  const x = Math.max(0, Math.min(Math.round(r.x), width - 1));
  const y = Math.max(0, Math.min(Math.round(r.y), height - 1));
  const w = Math.max(1, Math.min(Math.round(r.width), width - x));
  const h = Math.max(1, Math.min(Math.round(r.height), height - y));
  return { x, y, width: w, height: h };
}

// `image` is whatever dtype the resource was produced at (16-bit BGRA for
// left/right/diff — the save-quality Mat; 8-bit for center, straight off the
// registry's own BGRA8 tap) — only `publishFrame`'s preview copy is forced
// down to 8-bit, `pending`/`save()` keep the original.
type Entry = { meta?: Serializable; image?: Mat };

export interface CaptureDeps {
  getTriple(): CalibratedTriple | null;
  volts(): { L: Pos; R: Pos };
  targetAngle(): Point2d;
  centerFrameSize(): Size;
  zoom(): number;
  capStack(): number;
  baseline(): number;
  wrapEnable(): boolean;
  /** Steer the target to an angle (used to visit each set-point in turn). */
  steerToAngle(angle: Point2d, distance_mm?: number, shift_deg?: number): void;
  /** One-shot read of the NEXT undistorted center frame (C-23 ruled Q2: an
   *  on-demand SHM read of the `undistort:<serial>` pipe — the session keeps
   *  that pipe connected while active, so the producer is running). Returns an
   *  independent Mat, or null on timeout / session not active. */
  readCenter(): Promise<Mat<Uint8Array> | null>;
  frame(name: string, payload: SessionFrameSource): void;
  telemetry(patch: {
    captureBusy?: boolean;
    capture_meta?: Record<string, Serializable>;
  }): void;
}

export interface CaptureController {
  /** True while a capture pass is running (drain-refusal probe — the
   *  multi-window switch path must not force-drain mid-capture). */
  readonly busy: boolean;
  run(setpoints: VoltPreviewQuery[]): Promise<void>;
  save(path: string, format: string): Promise<void>;
  discard(): void;
  /** Resolves once any in-flight `run()` completes (immediately if idle).
   *  The session must await this before releasing camera leases — a capture
   *  in progress is still actively reading `lease.camera.stream` directly
   *  (V1: docs/history/refactor/orchestrator.md §6, same bug class as C2's
   *  force-close-under-an-active-consumer). */
  waitIdle(): Promise<void>;
}

export function createCapture(deps: CaptureDeps): CaptureController {
  const pending = new Map<string, Entry | Entry[]>();
  let busy = false;
  let active: Promise<void> = Promise.resolve();

  /** The next undistorted center frame (C-23: one-shot pipe read via deps —
   *  already an independent Mat). Throws on timeout so the pass fails loudly
   *  instead of capturing a stale/absent center. */
  async function requestCenterView(): Promise<Mat<Uint8Array>> {
    const view = await deps.readCenter();
    if (!view) throw new Error("capture: no center frame (undistort pipe timeout)");
    return view;
  }

  // `s.telemetry()` merges shallowly — a patch containing `capture_meta`
  // *replaces* the whole map, it doesn't add a key to it. So every update
  // resends the full accumulated snapshot, not just the resource that changed.
  function publishMeta(): void {
    const meta: Record<string, Serializable> = {};
    for (const [name, entry] of pending) {
      meta[name] = (
        Array.isArray(entry) ? entry.map((e) => e.meta ?? null) : (entry.meta ?? null)
      ) as Serializable;
    }
    deps.telemetry({ capture_meta: meta });
  }

  function publishFrame(name: string, index: number | undefined, image: Mat): void {
    const channel = index === undefined ? `capture:${name}` : `capture:${name}#${index}`;
    // 8-bit BGRA preview — runtime writes session frames into shm, so publish
    // the Mat directly instead of first copying it into a wire payload.
    const preview = image instanceof Uint8Array ? image : convertType(image, "8U");
    deps.frame(channel, preview);
  }

  /** Store a resource once ("wide") — never indexed, even mid a set-points
   *  capture, matching the original `provide("wide", ...)` call site. */
  function provideOnce(name: string, entry: Entry): void {
    pending.set(name, entry);
    publishMeta();
    if (entry.image) publishFrame(name, undefined, entry.image);
  }

  /** Store a per-pass resource — accumulates as an array iff this capture
   *  has more than one set-point, matching `Capture.capture()`'s provide(). */
  function provideIndexed(name: string, entry: Entry, indexed: boolean): void {
    if (!indexed) {
      pending.set(name, entry);
      publishMeta();
      if (entry.image) publishFrame(name, undefined, entry.image);
      return;
    }
    const existing = pending.get(name);
    const arr = Array.isArray(existing) ? existing : [];
    if (!Array.isArray(existing)) pending.set(name, arr);
    const index = arr.length;
    arr.push(entry);
    publishMeta();
    if (entry.image) publishFrame(name, index, entry.image);
  }

  async function captureOnce(indexed: boolean): Promise<void> {
    const triple = deps.getTriple();
    if (!triple?.undistort) return;
    const { undistort, conv, leases } = triple;
    const zoom = Math.max(1, deps.zoom());
    const baseline = deps.baseline();
    const volts = deps.volts();
    const A = { L: conv.V2A.L(volts.L), R: conv.V2A.R(volts.R) };
    const intrinsics = {
      L: deriveFoveaIntrinsics(undistort, A.L, zoom),
      R: deriveFoveaIntrinsics(undistort, A.R, zoom),
    };
    const Q = createQMatrix(intrinsics.L, intrinsics.R, baseline);
    provideIndexed(
      "fovea",
      { meta: { Q: matToArray(Q), baseline, "baseline.unit": "millimeter" } as Serializable },
      indexed,
    );

    // "center": the current undistorted+sliced view around the target — a
    // one-shot `undistort:<serial>` pipe read (already an independent Mat).
    const centerRaw = await requestCenterView();
    const { width, height } = deps.centerFrameSize();
    const size = { width: width / zoom, height: height / zoom };
    const at = undistort.position([deps.targetAngle()], false)[0];
    const rect = clampRect(RECT.fromCenter(at, size), width, height);
    provideIndexed("center", { image: slice(centerRaw, rect) }, indexed);

    // "left"/"right": fresh raw stack (independent consumers of the shared
    // camera stream — safe alongside the registry's own preview loop and any
    // concurrent recording, see docs/history/refactor/orchestrator.md roadmap item 6).
    const [lStack, rStack] = await Promise.all([
      stack(leases.L.camera.stream, deps.capStack()),
      stack(leases.R.camera.stream, deps.capStack()),
    ]);
    const wrap = deps.wrapEnable();
    const l = normalizeFovea(lStack, conv.A2H.L(A.L), wrap);
    const r = normalizeFovea(rStack, conv.A2H.R(A.R), wrap);
    const sensor_size = undistort.sensor_size;
    provideIndexed(
      "left",
      {
        image: l,
        meta: {
          sensor_size,
          volt: volts.L,
          "volt.unit": "volt",
          angle: A.L,
          "angle.unit": "radian",
          intrinsics: intrinsics.L,
        } as Serializable,
      },
      indexed,
    );
    provideIndexed(
      "right",
      {
        image: r,
        meta: {
          sensor_size,
          volt: volts.R,
          "volt.unit": "volt",
          angle: A.R,
          "angle.unit": "radian",
          intrinsics: intrinsics.R,
        } as Serializable,
      },
      indexed,
    );
    provideIndexed("diff", { image: diff(l, r, true) }, indexed);
  }

  function normalizeFovea(
    { image, format }: { image: Mat<Float32Array>; format: any },
    H: Mat<Float64Array>,
    wrap: boolean,
  ): Mat<Uint16Array> {
    const bgra = makeBGRA(convertType(image, "16U"), format);
    return wrap ? wrapPerspective(bgra, H) : bgra;
  }

  async function runInner(setpoints: VoltPreviewQuery[]): Promise<void> {
    busy = true;
    pending.clear();
    deps.telemetry({ captureBusy: true, capture_meta: {} });
    try {
      const triple = deps.getTriple();
      if (!triple?.undistort) throw new Error("Calibrated triple not ready");
      const { sensor_size, focal, center, fov } = triple.undistort;
      provideOnce("wide", { meta: { sensor_size, focal, center, fov } as Serializable });
      if (setpoints.length === 0) {
        await captureOnce(false);
      } else {
        for (const sp of setpoints) {
          deps.steerToAngle(sp.value, sp.distance_mm, sp.shift_deg);
          await delay(100); // let the mirrors settle before capturing
          await captureOnce(true);
        }
      }
    } finally {
      busy = false;
      deps.telemetry({ captureBusy: false });
    }
  }

  return {
    get busy() {
      return busy;
    },

    run(setpoints) {
      if (busy) return active;
      active = runInner(setpoints);
      return active;
    },

    async save(path, format) {
      mkdirSync(path, { recursive: true });
      const tasks: Promise<unknown>[] = [];
      for (const [name, items] of pending) {
        if (Array.isArray(items)) {
          const directory = resolve(path, name);
          mkdirSync(directory, { recursive: true });
          const pad = Math.max(2, items.length.toString().length);
          for (const [i, { meta, image }] of items.entries()) {
            const sequence = i.toString().padStart(pad, "0");
            if (meta)
              tasks.push(
                fs.writeFile(resolve(directory, `${sequence}.json`), JSON.stringify(meta, null, 2)),
              );
            if (image)
              tasks.push(Vision.save(RGB2BGR(image), resolve(directory, `${sequence}.${format}`)));
          }
        } else {
          const { meta, image } = items;
          if (meta)
            tasks.push(fs.writeFile(resolve(path, `${name}.json`), JSON.stringify(meta, null, 2)));
          if (image) tasks.push(Vision.save(RGB2BGR(image), resolve(path, `${name}.${format}`)));
        }
      }
      await Promise.all(tasks);
      pending.clear();
      deps.telemetry({ capture_meta: {} });
    },

    discard() {
      pending.clear();
      deps.telemetry({ capture_meta: {} });
    },

    waitIdle() {
      return active;
    },
  };
}
