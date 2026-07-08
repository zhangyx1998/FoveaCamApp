// A-24 Stage 3: the native-probe splice. C's SHM pipe producers + B's 1d KCF
// tracker expose native meters in the `WorkloadSnapshot` shape; this seam folds
// them into `system.perfSnapshot.workloads` next to the JS meters WITHOUT
// `system.ts` touching `core`. Covers the registry and the end-to-end splice
// through the real system session (with a fake probe standing in for the native
// thread).

import { describe, expect, it } from "vitest";
import { Channel, topic, type FrameTopicStats } from "@lib/orchestrator/protocol";
import { createEndpointPair } from "./fake-endpoint";
import { registerNativeProbe, nativeProbes } from "@orchestrator/native-probes";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";

function probeSnap(name: string): WorkloadSnapshot {
  const t = Date.now();
  return {
    name,
    window: { startedAt: t - 1000, snapshotAt: t, uptimeMs: 1000 },
    utilization: 0.42,
    busyMs: 420,
    inputs: { frame: { count: 30, ratePerSec: 30, maxIntervalMs: 40 } },
    outputs: { shm: { count: 30, ratePerSec: 30, maxIntervalMs: 40 } },
    drops: { total: 0, ratePerSec: 0, byReason: {} },
  };
}

describe("native-probes registry", () => {
  it("merges registered batches and drops them on dispose", () => {
    const dispose = registerNativeProbe(() => ({ "camera:X": probeSnap("camera:X") }));
    try {
      expect(nativeProbes()["camera:X"]).toMatchObject({ name: "camera:X" });
    } finally {
      dispose();
    }
    expect(nativeProbes()["camera:X"]).toBeUndefined(); // gone after dispose
  });

  it("skips a throwing probe without breaking the merge", () => {
    const good = registerNativeProbe(() => ({ "ok": probeSnap("ok") }));
    const bad = registerNativeProbe(() => {
      throw new Error("probe blew up");
    });
    try {
      const merged = nativeProbes();
      expect(merged["ok"]).toBeDefined();
      expect(Object.keys(merged)).toEqual(["ok"]);
    } finally {
      good();
      bad();
    }
  });

  // Rig regression (2026-07-08): the converter/tracker serializers emitted a
  // FLAT shape (uptimeMs + dropTotal, no window/drops); one such row crashed
  // perfSnapshot's graph fold (`.ratePerSec` of undefined) → empty pipeline
  // graph + failed snapshot export in every app. The merge must coerce flat
  // rows to the full schema, extra fields passing through.
  it("normalizes a legacy flat probe row (no window/drops) to full schema", () => {
    const flat = {
      name: "converter:camera/SN1/convert",
      uptimeMs: 2000,
      utilization: 0.5,
      busyMs: 1000,
      dropTotal: 4,
      inputs: { frame: { count: 60, ratePerSec: 30, maxIntervalMs: 40 } },
      outputs: { bgra: { count: 60, ratePerSec: 30, maxIntervalMs: 40 } },
      targets: [{ id: "t1" }], // multi-KCF-style extra field must survive
    } as unknown as WorkloadSnapshot;
    const dispose = registerNativeProbe(() => ({ [flat.name]: flat }));
    try {
      const row = nativeProbes()[flat.name]!;
      expect(row.drops).toEqual({ total: 4, ratePerSec: 2, byReason: {} });
      expect(row.window.uptimeMs).toBe(2000);
      expect((row as unknown as { targets: unknown[] }).targets).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});

describe("system.perfSnapshot folds native probes into workloads", () => {
  it("includes a probed native stream alongside the JS workloads", async () => {
    const { systemSession } = await import("@orchestrator/sessions/system");
    const frameStats = (): Record<string, FrameTopicStats> => ({});
    const dispose = registerNativeProbe(() => ({
      "camera:SN1": probeSnap("camera:SN1"),
    }));
    try {
      const session = systemSession(() => [], frameStats);
      const [serverEp, clientEp] = createEndpointPair();
      const server = new Channel(serverEp);
      const client = new Channel(clientEp);
      session.attach(server);

      const snapshot = (await client.request(
        topic.command("system", "perfSnapshot"),
      )) as { workloads: Record<string, WorkloadSnapshot> };

      // The native pipe producer stream shows up in `workloads`, in the same
      // shape the profiler renders JS meters.
      expect(snapshot.workloads["camera:SN1"]).toMatchObject({
        name: "camera:SN1",
        utilization: 0.42,
        inputs: { frame: { count: 30, maxIntervalMs: 40 } },
      });
    } finally {
      dispose();
    }
  });
});
