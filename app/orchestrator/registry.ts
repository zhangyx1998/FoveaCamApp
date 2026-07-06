// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Camera/stream registry. Centralizes camera ownership *by resource* (one native
// `Camera` per serial) instead of by session: live-view, manage-cameras, and the
// (future) control loops lease the same handle through `acquire(serial)`, so they
// never open the same camera twice or fight over its pixel format/config.
//
// Each shared camera runs at most one BGRA preview loop, fanning a single
// converted payload out to every subscribed sink — so N windows viewing one
// camera cost one acquisition and one conversion, delivering the shared-stream
// half of the multi-window/projector goal (§2 secondary).

import type { Camera } from "core/Aravis";
import type { ShmSlot, Writer as ShmWriter } from "core/Shm";
import type { Mat } from "core/Vision";
import type { FramePayload } from "@lib/orchestrator/protocol";
import type { Role } from "@lib/camera-config";
import { applyStoredConfig, cameraConfigPath, listCameraInfo } from "./camera.js";
import { guarded, timeSpan } from "./diagnostics.js";
import { read } from "./store-hub.js";
import { registerWorkload, type WorkloadHandle } from "./metering.js";

type FrameSink = (payload: FramePayload) => void;
type ViewSink = (view: Mat<Uint8Array>) => void;

interface Shared {
  readonly serial: string;
  camera: Camera;
  refs: number;
  readonly sinks: Set<FrameSink>; // transport: get an SHM descriptor payload
  readonly viewSinks: Set<ViewSink>; // in-process: get the BGRA Mat view
  shmWriter?: ShmWriter;
  // Persistent tap buffer: `slot.view()` is a fresh cage-local snapshot per
  // call under Electron (V13) — taps are served by native `copyTo` into this
  // one reused buffer instead (one memcpy, zero steady-state allocation).
  tapView?: Mat<Uint8Array>;
  abort: boolean;
  loop: Promise<void> | null; // in-flight preview loop, awaited on stop
  closed: boolean; // native handle released (guards double-release)
  // Perf substrate (docs/refactor/workload-metering.md, "registry preview
  // loop (per serial)" — first citizen): one meter per shared camera,
  // registered alongside it and disposed alongside it, so re-acquiring the
  // same serial after a full release starts a fresh window.
  readonly workload: WorkloadHandle;
}

/** A lease on one shared camera. Drop it with `release()` when done. */
export interface CameraLease {
  /** The shared native handle (property reads/writes act on the real camera). */
  readonly camera: Camera;
  /** Subscribe to BGRA preview frames (copied payloads); returns unsubscribe. */
  onFrame(sink: FrameSink): () => void;
  /**
   * Tap the shared stream's BGRA `Mat` in-process (no copy) — for orchestrator
   * vision (e.g. tracking). The Mat is the reused buffer: it is valid only for
   * the duration of the synchronous call; copy out (slice/cvtColor) to retain.
   */
  onView(sink: ViewSink): () => void;
  /** Stop the preview loop, run `mutate` (e.g. pixel-format change), restart. */
  reconfigure(mutate: () => void | Promise<void>): Promise<void>;
  /** Release this lease; the camera is closed when the last lease drops. */
  release(): void;
}

const shared = new Map<string, Shared>();
const shmBootSweep = import("core").then(({ Shm }) => Shm.sweep());
// Close promises not yet settled, tracked outside `shared` (which `closeShared`
// empties immediately) so `releaseAll` can await a close that started just
// before it was called — otherwise it can return while a native handle is
// still mid-release, and a renderer racing to open the same camera finds it
// still claimed. See docs/refactor/orchestrator.md §12.1 C1.
const closing = new Set<Promise<void>>();

/** Serials with a live lease (preview running or not). */
export const leasedSerials = (): string[] => [...shared.keys()];

const hasConsumers = (s: Shared): boolean =>
  s.sinks.size > 0 || s.viewSinks.size > 0;

/**
 * Publish to every sink, isolating one throwing sink from the others and from
 * the loop itself — an uncaught throw here would otherwise reject the shared
 * loop promise and silently stop frames for every viewer of this camera.
 */
function publish<T>(serial: string, sinks: Set<(v: T) => void>, value: T): void {
  for (const sink of sinks)
    guarded(`registry:${serial}`, () => sink(value));
}

async function shmWriter(s: Shared): Promise<ShmWriter> {
  if (!s.shmWriter) {
    await shmBootSweep;
    const { Shm } = await import("core");
    s.shmWriter = new Shm.Writer(Shm.topicKey(`camera:${s.serial}`));
  }
  return s.shmWriter;
}

function startLoop(s: Shared): void {
  if (s.loop || !hasConsumers(s)) return; // already running / nothing to feed
  s.abort = false;
  s.loop = (async () => {
    try {
      for (const frame of s.camera.stream) {
        if (s.abort || !hasConsumers(s)) break;
        if (!frame) {
          // No frame ready — yield without spinning the CPU. Not busy time:
          // the loop is idle here, not blocked on real work.
          await new Promise((r) => setImmediate(r));
          continue;
        }
        s.workload.ingest("camera");
        s.workload.begin();
        // Host-clock capture stamp (native buffer timestamp is a separate
        // device clock domain — not comparable to renderer-side Date.now()
        // without the correlation the synced-capture plan does; this is the
        // best same-clock proxy for "when did this frame become available").
        const tCapture = Date.now();
        const deviceTimestamp = frame.deviceTimestamp;
        const systemTimestamp = frame.systemTimestamp;
        const height = frame.height;
        const width = frame.width;
        const convertStart = performance.now();
        const writer = await shmWriter(s);
        const slot = writer.nextSlot([height, width], 4);
        await frame.view("BGRA8", slot as unknown as BufferLike);
        const convertMs = performance.now() - convertStart;
        frame.release();
        const payload = writer.publish({
          tCapture,
          convertMs,
          deviceTimestamp,
          systemTimestamp,
        }) as FramePayload;
        if (s.viewSinks.size > 0) {
          const bytes = height * width * 4;
          if (!s.tapView || s.tapView.byteLength !== bytes)
            s.tapView = new Uint8Array(bytes) as Mat<Uint8Array>;
          (slot as ShmSlot).copyTo(s.tapView);
          s.tapView.shape = [height, width];
          s.tapView.channels = 4;
          publish(s.serial, s.viewSinks, s.tapView);
          s.workload.emit("view");
        }
        if (s.sinks.size > 0) {
          publish(s.serial, s.sinks, payload);
          s.workload.emit("shm");
        }
        s.workload.end();
      }
    } finally {
      s.loop = null;
    }
  })();
}

async function stopLoop(s: Shared): Promise<void> {
  s.abort = true;
  await s.loop; // native stream stop is cross-thread; wait for real exit
}

// Stop the loop and free the native camera handle (releasing the per-process
// device claim). Idempotent — safe if a lingering lease also releases later.
function closeShared(s: Shared): Promise<void> {
  if (s.closed) return Promise.resolve();
  s.closed = true;
  shared.delete(s.serial);
  s.sinks.clear();
  s.viewSinks.clear();
  s.shmWriter?.close();
  s.shmWriter = undefined;
  s.workload.dispose();
  const p = stopLoop(s).then(() => s.camera.release());
  // Track until settled: `s` is already out of `shared` by the time this
  // resolves, so a `releaseAll` call that lands *after* this starts but
  // *before* it finishes would otherwise miss it entirely (see C1).
  closing.add(p);
  p.finally(() => closing.delete(p));
  return p;
}

/**
 * Force-release every camera the registry holds, awaiting the native handles to
 * close — including ones already mid-close from an earlier, unrelated release
 * (e.g. a lease dropped by a session's idle handler moments ago). Used to hand
 * devices back to a renderer module that still opens cameras directly
 * (non-migrated calibrate-* / manual-control): cameras are exclusive per OS
 * process, so the orchestrator must fully let go before the renderer can claim
 * them, not just have *started* letting go.
 */
export async function releaseAll(): Promise<void> {
  await Promise.all([...shared.values()].map(closeShared).concat([...closing]));
}

/**
 * Retry `attempt` with backoff until it returns a truthy result or the bounded
 * window elapses. Absorbs the renderer→orchestrator camera handoff race
 * (docs/refactor/orchestrator.md RT1): a camera mid-release by the *other*
 * process briefly fails `arv_camera_new` even though it becomes available
 * again within a few seconds (Aravis/Camera exclusivity is per OS process —
 * see the hard rules in the refactor doc). At session activation, "not
 * available yet" and "not connected" are indistinguishable without waiting,
 * so every camera-owning activation should go through this instead of a
 * single `acquire()` attempt.
 */
export async function retryUntil<T>(
  attempt: () => Promise<T | null>,
  { timeoutMs = 5000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await attempt();
    if (result) return result;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Promote a freshly-opened `Camera` into the registry as a new `Shared`
 *  entry (stored config applied). Shared by `acquire()`'s first-lease path
 *  and `acquireMany()`'s bulk-discovery path so both agree on setup. */
async function registerShared(camera: Camera): Promise<Shared> {
  await timeSpan("camera.applyStoredConfig", () => applyStoredConfig(camera), {
    serial: camera.serial,
  });
  const s: Shared = {
    serial: camera.serial,
    camera,
    refs: 0,
    sinks: new Set(),
    viewSinks: new Set(),
    abort: false,
    loop: null,
    closed: false,
    workload: registerWorkload(`registry:${camera.serial}`, {
      inputs: ["camera"],
      outputs: ["shm", "view"],
    }),
  };
  shared.set(camera.serial, s);
  return s;
}

/**
 * Lease the camera with this serial, opening + applying its stored config on the
 * first lease. Returns `null` if the camera is not connected.
 */
export async function acquire(serial: string): Promise<CameraLease | null> {
  let s = shared.get(serial);
  if (!s) {
    const { Camera } = await import("core/Aravis");
    const cameras = await timeSpan("camera.enumerate", () => Camera.list(), { serial });
    const camera = cameras.find((c) => c.serial === serial) ?? null;
    for (const c of cameras) if (c !== camera) c.release();
    if (!camera) return null;
    s = await registerShared(camera);
  }
  s.refs++;

  let released = false;
  const sinks = new Set<FrameSink>();
  const viewSinks = new Set<ViewSink>();
  const lease: CameraLease = {
    get camera() {
      return s!.camera;
    },
    onFrame(sink) {
      sinks.add(sink);
      s!.sinks.add(sink);
      startLoop(s!);
      return () => {
        sinks.delete(sink);
        s!.sinks.delete(sink);
      };
    },
    onView(sink) {
      viewSinks.add(sink);
      s!.viewSinks.add(sink);
      startLoop(s!);
      return () => {
        viewSinks.delete(sink);
        s!.viewSinks.delete(sink);
      };
    },
    async reconfigure(mutate) {
      await stopLoop(s!);
      try {
        await mutate();
      } finally {
        startLoop(s!); // no-op if nothing to feed; fresh buffer otherwise
      }
    },
    release() {
      if (released) return;
      released = true;
      for (const sink of sinks) s!.sinks.delete(sink);
      for (const sink of viewSinks) s!.viewSinks.delete(sink);
      sinks.clear();
      viewSinks.clear();
      if (--s!.refs > 0) return;
      void closeShared(s!);
    },
  };
  return lease;
}

/**
 * Lease every serial in `serials` that's connected, in at most one discovery
 * pass total (RT1 F3) — vs. calling `acquire()` per serial, which pays its
 * own `Camera.list()` for every not-yet-shared serial (up to N discovery+open
 * passes for N cameras). Used by activations that know in advance exactly
 * which cameras they want (e.g. a calibrated L/C/R triple). A serial with no
 * entry in the returned map was not connected.
 */
export async function acquireMany(
  serials: string[],
): Promise<Map<string, CameraLease>> {
  if (serials.some((serial) => !shared.has(serial))) {
    const wanted = new Set(serials);
    const { Camera } = await import("core/Aravis");
    const cameras = await timeSpan("camera.enumerate", () => Camera.list(), {
      wanted: serials.length,
    });
    for (const camera of cameras) {
      if (shared.has(camera.serial) || !wanted.has(camera.serial)) {
        camera.release();
        continue;
      }
      await registerShared(camera);
    }
  }
  const leased = new Map<string, CameraLease>();
  for (const serial of serials) {
    // Every wanted, connected serial is now in `shared` (either already, or
    // just registered above) — this hits `acquire()`'s fast path, no further
    // `Camera.list()` calls.
    const lease = await acquire(serial);
    if (lease) leased.set(serial, lease);
  }
  return leased;
}

/**
 * One pass: read every connected camera's stored role *without opening it*
 * (`cameraConfigPath` only needs vendor/model/serial — RT1 F3), lease only
 * the L/C/R matches in one bulk discovery call (`acquireMany`), drop the
 * rest. Returns null (releasing any partial match) unless all three roles
 * are covered. Shared by every session that needs the calibrated triple
 * (originally `tracking-single`'s `tryMatchTriple`) — wrap with
 * `retryUntil(matchTriple)` at the call site, since a camera still
 * mid-release by another process is simply absent from `listCameraInfo()`
 * for a beat, not present-but-failing (RT1).
 */
export async function matchTriple(): Promise<Record<Role, CameraLease> | null> {
  const roleOf = new Map<string, Role>();
  for (const info of await listCameraInfo()) {
    const { role } = await read<{ role?: Role }>(cameraConfigPath(info), {});
    if (role === "L" || role === "C" || role === "R") roleOf.set(info.serial, role);
  }
  const leased = await acquireMany([...roleOf.keys()]);
  const matched: Partial<Record<Role, CameraLease>> = {};
  for (const [serial, role] of roleOf) {
    const lease = leased.get(serial);
    if (!lease) continue;
    if (!matched[role]) matched[role] = lease;
    else lease.release(); // two cameras stored with the same role
  }
  if (matched.L && matched.C && matched.R)
    return matched as Record<Role, CameraLease>;
  for (const l of Object.values(matched)) l?.release();
  return null;
}
