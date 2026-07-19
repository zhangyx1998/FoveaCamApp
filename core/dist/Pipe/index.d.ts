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
    /** Ring capacity (max per-fovea footprint); defaults to nominal. */
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
    epoch: number; // segment generation (reuse-safe identity)
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
  /** Scaffold only: drive a pipe with synthetic frames at `fps`
   *  (byte = `seed + frame#`). The camera/CV producer replaces this. */
  export function attachSynthetic(id: string, fps: number, seed: number): void;

  /** One probed workload snapshot — same shape as the JS `WorkloadSnapshot`
   *  so the orchestrator folds a native producer stream into
   *  `perfSnapshot.workloads` and the profiler renders it identically. */
  export interface ProbeSnapshot {
    name: string;
    window: { startedAt: number; snapshotAt: number; uptimeMs: number };
    utilization: number;
    busyMs: number;
    inputs: Record<string, { count: number; ratePerSec: number; maxIntervalMs: number }>;
    outputs: Record<string, { count: number; ratePerSec: number; maxIntervalMs: number }>;
    drops: { total: number; ratePerSec: number; byReason: Record<string, number> };
    /** FIFO-input queue metering. Present
     *  ONLY on a FIFO-fed brick's meter (e.g. the undistort brick); absent on
     *  latest-wins/Leaky-fed producers. `highWater` = windowed (10s) max sampled
     *  depth, `depth` = last sample, `capacity` = the FIFO bound. */
    queue?: { depth: number; highWater: number; capacity: number };
  }
  /** Out-of-loop probe of a pipe's native producer meter. Read at ~1 Hz;
   *  never per-frame — the free-running producer thread records lock-free. */
  export function probe(id: string): ProbeSnapshot;
  /** Probe EVERY live pipe → `{[pipeId]: ProbeSnapshot}`. Dropped pipes
   *  are absent — no stale workload rows under churn. */
  export function probeAll(): Record<string, ProbeSnapshot>;
  /** One advertised pipe's identity/liveness row. `bytesTotal`
   *  counts ACTIVE ring-written bytes since advertise (exact under
   *  variable-size fovea frames) — diff snapshots for per-edge MB/s. */
  export interface PipeListEntry {
    id: string;
    spec: PipeSpec;
    epoch: number;
    consumers: number;
    closed: boolean;
    bytesTotal: number;
  }
  /** Enumerate every ADVERTISED pipe WITHOUT connecting — the graph topology's
   *  discovery source. Dropped pipes are absent. */
  export function list(): PipeListEntry[];
  /** Test hook: pause the synthetic producer for ~`ms` so the probed
   *  `maxIntervalMs` spikes — proving a producer stall is visible out-of-loop. */
  export function injectStall(id: string, ms: number): void;
  /** Test hook: offer one synthetic frame of active size `w×h` (filled
   *  with `byte`) into a live pipe — drives the resize/reuse tests. */
  export function offerFrame(id: string, w: number, h: number, byte: number): void;
  /** Test hooks: install a consumer gate that records each fire, and
   *  read the log — verifies the gate's immediate-on-register + 0↔1 edge firing.
   *  (The REAL gate is a C++ `setConsumerGate`, registered by B's Aravis side.) */
  export function installTestGate(id: string): void;
  export function testGateLog(id: string): boolean[];

  /** Tear down a pipe entirely (stop producer, close publisher, unlink segment). */
  export function drop(id: string): void;
}
