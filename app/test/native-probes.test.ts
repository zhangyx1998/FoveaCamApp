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
