// C-17: the pipe broker session — advertises specs into state and brokers
// connect/disconnect to core.Pipe (a fake broker here; native is proven by
// core/test/09-pipe.ts). Driven over a real Channel pair.

import { describe, expect, it, vi } from "vitest";
import { Channel, topic } from "@lib/orchestrator/protocol";
import { pipeSession, type PipeBroker } from "@orchestrator/pipe-session";
import type { PipeSpec, PipeHandle } from "@lib/orchestrator/pipe-contract";
import { createEndpointPair, flush } from "./fake-endpoint";

function spec(id: string): PipeSpec {
  return {
    id,
    pixelFormat: "Mono8",
    dtype: "U8",
    width: 4,
    height: 4,
    channels: 1,
    stride: 4,
    bytesPerFrame: 16,
    ringDepth: 3,
  };
}

function fakeBroker() {
  const consumers = new Map<string, number>();
  const advertised: string[] = [];
  const epochs = new Map<string, number>();
  const broker: PipeBroker = {
    advertise: vi.fn((s: PipeSpec) => {
      advertised.push(s.id);
      consumers.set(s.id, 0);
      const e = (epochs.get(s.id) ?? 0) + 1; // bumps per (re-)advertise
      epochs.set(s.id, e);
      return e;
    }),
    connect: vi.fn((id: string): PipeHandle => {
      consumers.set(id, (consumers.get(id) ?? 0) + 1);
      return {
        pipeId: id,
        shmName: `/fv.p.${id}.g${epochs.get(id) ?? 1}`,
        spec: spec(id),
        ringDepth: 3,
        epoch: epochs.get(id) ?? 1,
        headerLayout: { layoutVersion: 3, magic: "FVSHMRG" },
      };
    }),
    disconnect: vi.fn((id: string) => {
      const n = Math.max(0, (consumers.get(id) ?? 0) - 1);
      consumers.set(id, n);
      return n;
    }),
    drop: vi.fn((id: string) => {
      consumers.delete(id);
    }),
  };
  return { broker, consumers, advertised, epochs };
}

function harness(specs: PipeSpec[]) {
  const { broker, consumers, advertised, epochs } = fakeBroker();
  const { session, advertise, unadvertise } = pipeSession({ specs, broker });
  const [serverEp, clientEp] = createEndpointPair();
  const server = new Channel(serverEp);
  const client = new Channel(clientEp);
  session.attach(server);
  session.subscribe(server);

  let pipesState: Record<string, { spec: PipeSpec; epoch: number }> = {};
  client.on(topic.state("pipes"), (patch: { key: string; value: never }) => {
    if (patch.key === "pipes") pipesState = patch.value;
  });

  return {
    call: <T = unknown>(cmd: string, arg?: unknown) =>
      client.request<T>(topic.command("pipes", cmd), arg),
    pipes: () => pipesState,
    consumers,
    advertised,
    epochs,
    advertise,
    unadvertise,
  };
}

describe("pipe session (C-17/C-20)", () => {
  it("advertises its specs into the discovery Record on build", async () => {
    const h = harness([spec("preview:L"), spec("preview:R")]);
    await flush();
    expect(h.advertised).toEqual(["preview:L", "preview:R"]);
    expect(Object.keys(h.pipes()).sort()).toEqual(["preview:L", "preview:R"]);
    expect(h.pipes()["preview:L"].epoch).toBe(1);
  });

  it("dynamic advertise/unadvertise updates the discovery Record (C-20 churn)", async () => {
    const h = harness([]);
    await flush();
    expect(h.pipes()).toEqual({});
    const epoch = h.advertise(spec("fovea:s:1"));
    await flush();
    expect(epoch).toBe(1);
    expect(Object.keys(h.pipes())).toEqual(["fovea:s:1"]);
    expect(h.pipes()["fovea:s:1"].epoch).toBe(1);
    h.unadvertise("fovea:s:1");
    await flush();
    expect(h.pipes()).toEqual({}); // vanished from discovery
    // Reuse the id → epoch bumps (reuse-safe identity).
    expect(h.advertise(spec("fovea:s:1"))).toBe(2);
    await flush();
    expect(h.pipes()["fovea:s:1"].epoch).toBe(2);
  });

  it("connectPipe brokers to core.Pipe.connect and returns the handle", async () => {
    const h = harness([spec("preview:L")]);
    const handle = await h.call<PipeHandle>("connectPipe", { pipeId: "preview:L" });
    expect(handle.shmName).toBe("/fv.p.preview:L.g1");
    expect(handle.headerLayout.layoutVersion).toBe(3);
    expect(handle.epoch).toBe(1);
    expect(h.consumers.get("preview:L")).toBe(1);
  });

  it("disconnectPipe decrements the publisher consumer refcount", async () => {
    const h = harness([spec("preview:L")]);
    await h.call("connectPipe", { pipeId: "preview:L" });
    await h.call("connectPipe", { pipeId: "preview:L" });
    expect(h.consumers.get("preview:L")).toBe(2);
    await h.call("disconnectPipe", { pipeId: "preview:L" });
    expect(h.consumers.get("preview:L")).toBe(1);
  });

  it("rejects an unknown pipeId instead of brokering it", async () => {
    const h = harness([spec("preview:L")]);
    await expect(h.call("connectPipe", { pipeId: "nope" })).rejects.toThrow(
      /unknown pipeId/,
    );
  });
});
