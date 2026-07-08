// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Vision-kernel seam (C-22b, WS1 real-1f). The vision worker
// (`vision-worker.ts`) owns SHM I/O + framing + MessagePort transport and is
// session-agnostic; each session's actual pixel work lives in a `VisionKernel`
// it dispatches to by `params.kind` (disparity-scope now; manual-control /
// tracking-single next). Kernels run INSIDE the worker thread — they may use
// core/Vision + core/Tracker synchronously (single-threaded loop, no busy-drop
// dance), and the worker converts their output Mats into transferred buffers.

import type { Mat } from "core/Vision";
import type { Role } from "./vision-worker-protocol.js";

/** One freshly-read frame handed to a kernel. `mat` is a worker-owned buffer,
 *  valid for the duration of the `process` call only (the worker reuses the
 *  per-role read buffer next tick) — a kernel that retains pixels past the call
 *  must copy (e.g. `getFoveaTile`/`wrapPerspective` already allocate fresh). */
export type KernelFrame = {
  mat: Mat<Uint8Array>;
  seq: number;
  deviceTimestamp?: number;
};

/** The frames new since the kernel's last `process` (a role is absent when its
 *  pipe produced no new frame this tick). */
export type FrameSet = Partial<Record<Role, KernelFrame>>;

/** A derived frame a kernel wants published — the worker copies `mat` into a
 *  fresh transferable `ArrayBuffer` before posting (transfer neuters it). */
export type KernelFrameOut = { name: string; mat: Mat<Uint8Array> };

/** A kernel's output for one tick: scalar `values` (fed to actuation/telemetry
 *  on main) + derived frames. `null` ⇒ nothing to post this tick. */
export type KernelOutput = {
  values: Record<string, unknown>;
  frames: KernelFrameOut[];
} | null;

export interface VisionKernel {
  /** Process whatever frames arrived this tick; return output to post or null.
   *  May be async — core/Vision ops (`resize`/`matchTemplate`) offload to the
   *  native threadpool and resolve on the worker loop; the worker awaits this
   *  sequentially, so a step is naturally non-reentrant (no busy-drop needed). */
  process(frames: FrameSet): KernelOutput | Promise<KernelOutput>;
  /** Apply a live param update from main (homographies, tuning, target…). */
  setParams(params: Record<string, unknown>): void;
  /** Release any native resources (trackers). */
  dispose(): void;
}

/** Kernel factory, selected by `params.kind` in the worker. */
export type KernelFactory = (params: Record<string, unknown>) => VisionKernel;
