declare module "core/Pipe" {
  /** Static typing of one advertised pipe (mirrors `Pipe::PipeSpec` and the
   *  renderer `pipe-contract.ts` `PipeSpec`). */
  export interface PipeSpec {
    id: string;
    pixelFormat: string;
    dtype: string;
    width: number;
    height: number;
    channels: number;
    stride: number;
    bytesPerFrame: number;
    ringDepth: number;
    /** C-20: ring capacity (max per-fovea footprint); defaults to nominal. */
    maxWidth?: number;
    maxHeight?: number;
    maxBytes?: number;
  }

  /** Result of `connect` — everything a consumer needs to map + read the
   *  segment via the reader addon (`reader.open(shmName)` + `readInto`). */
  export interface PipeHandle {
    pipeId: string;
    shmName: string;
    spec: PipeSpec;
    ringDepth: number;
    epoch: number; // segment generation (C-20 reuse-safe identity)
    headerLayout: { layoutVersion: number; magic: string };
  }

  /** Register a pipe's spec + create its publisher. Idempotent for a LIVE id
   *  (returns its current epoch); a first advertise or one after `drop` bumps
   *  the per-id epoch → a new segment. Returns the epoch. */
  export function advertise(spec: PipeSpec): number;
  /** One-time consumer handshake: ensures the publisher, refcount++, returns
   *  the handle. */
  export function connect(id: string): PipeHandle;
  /** Release a consumer (refcount--); returns the new consumer count. At zero
   *  the publisher pauses production but the pipe stays advertised. */
  export function disconnect(id: string): number;
  /** Current consumer refcount. */
  export function consumers(id: string): number;
  /** Producer-side close: `state=CLOSED` after the final frame, stop the
   *  publisher thread. */
  export function close(id: string): void;
  /** Scaffold only (WS1 1c-PREP): drive a pipe with synthetic frames at `fps`
   *  (byte = `seed + frame#`). 1c/1d replace this with the camera/CV producer. */
  export function attachSynthetic(id: string, fps: number, seed: number): void;

  /** One probed workload snapshot — same shape as the JS `WorkloadSnapshot`
   *  (C-18), so the orchestrator folds a native producer stream into
   *  `perfSnapshot.workloads` and the profiler renders it identically. */
  export interface ProbeSnapshot {
    name: string;
    window: { startedAt: number; snapshotAt: number; uptimeMs: number };
    utilization: number;
    busyMs: number;
    inputs: Record<string, { count: number; ratePerSec: number; maxIntervalMs: number }>;
    outputs: Record<string, { count: number; ratePerSec: number; maxIntervalMs: number }>;
    drops: { total: number; ratePerSec: number; byReason: Record<string, number> };
  }
  /** Out-of-loop probe of a pipe's native producer meter (C-19). Read at ~1 Hz;
   *  never per-frame — the free-running producer thread records lock-free. */
  export function probe(id: string): ProbeSnapshot;
  /** Probe EVERY live pipe → `{[pipeId]: ProbeSnapshot}` (C-20). Dropped pipes
   *  are absent — no stale workload rows under churn. */
  export function probeAll(): Record<string, ProbeSnapshot>;
  /** Test hook (C-19): pause the synthetic producer for ~`ms` so the probed
   *  `maxIntervalMs` spikes — proving a producer stall is visible out-of-loop. */
  export function injectStall(id: string, ms: number): void;
  /** Test hook (C-20): offer one synthetic frame of active size `w×h` (filled
   *  with `byte`) into a live pipe — drives the resize/reuse tests. */
  export function offerFrame(id: string, w: number, h: number, byte: number): void;
  /** Test hooks (C-21): install a consumer gate that records each fire, and
   *  read the log — verifies the gate's immediate-on-register + 0↔1 edge firing.
   *  (The REAL gate is a C++ `setConsumerGate`, registered by B's Aravis side.) */
  export function installTestGate(id: string): void;
  export function testGateLog(id: string): boolean[];

  /** Tear down a pipe entirely (stop producer, close publisher, unlink segment). */
  export function drop(id: string): void;
}
