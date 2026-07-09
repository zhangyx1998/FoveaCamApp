// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { ProbeSnapshot } from "core/Pipe";

declare module "core/Topology" {
  /** Path to the resolved native module injected by JS loader */
  export const __origin__: string;

  /** What a stream carries (mirror of `graph-contract.ts` `StreamType`;
   *  native bricks only ever emit the frame arm today). */
  export type StreamType = {
    kind: "frame";
    pixelFormat: string;
    dtype: string;
  };

  /** One ACTUAL live input connection (= one edge INTO this node). */
  export interface NodeInput {
    from: string;
    port: string;
    type: StreamType;
    /** Transport lossiness of THIS edge (mirror of `graph-contract.ts`
     *  `NodeInput.lossy`). Absent = the graph fold defaults it from the
     *  producer's transport; explicit `false` marks a lossless FIFO edge
     *  (convert→undistort) that must WIN over that default; `true` marks an
     *  explicitly latest-wins edge. */
    lossy?: boolean;
  }

  /**
   * UNIVERSAL node self-report (unified-time-and-topology §6) — the native
   * mirror of `graph-contract.ts` `NodeReport`. One row per live native brick
   * (convert/undistort/fovea, `transport: "native"` — promoted to `"pipe"`
   * with `epoch` + `pipe` extras when its output id is a live advertised SHM
   * pipe) plus one plain `kind: "pipe"` row per advertised pipe no brick
   * claimed (synthetic/worker pipes). `inputs` reflect the ACTUAL channel
   * connections (convert←camera, undistort←convert, fovea←undistort) — the
   * graph's only edge source; `buildTopologyFromReports` derives edges
   * mechanically.
   */
  export interface NodeReport {
    id: string;
    kind: string; // "convert" | "undistort" | "fovea" | "pipe" | ...
    transport: "pipe" | "native";
    inputs: NodeInput[];
    output: StreamType | null;
    /** Reuse-safe identity generation (C-20); pipe-backed rows only. */
    epoch?: number;
    /** Full meter snapshot (the converged WorkloadSnapshot schema). */
    stats?: ProbeSnapshot;
    /** Pipe-transport extras (`transport === "pipe"` rows only). */
    pipe?: { consumers: number; bytesTotal: number };
  }

  /**
   * Consolidated topology report: every live native brick + advertised pipe,
   * one call (replaces deriving the graph from `*ProbeAll()` + `Pipe.list()`
   * — both of which remain exported during the JS migration). Probe at ~1 Hz;
   * never per-frame.
   */
  export function report(): NodeReport[];
}
