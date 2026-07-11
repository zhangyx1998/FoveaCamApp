// calibrate-intrinsic session — the calibration-review-2026-07-11 fix wave:
//   #5  select() supersede guard (single-capture's pattern) — a racing second
//       select / deselect releases the late lease instead of installing it.
//   #15 failed lease → s.fail (user-visible), not a frozen overlay.
//   #4  calibrateNow snapshots state before the first await, bails (tray
//       message) on a mid-solve camera switch, and is covered by busy().
//   #13 minimum-sample gate + zero-sample marker capture refusal + actionable
//       OpenCV solve-error mapping.
//   #16 removeRecord by stable id; scale change keeps records; stale
//       detections not capturable after a restart; double-click solve guard.
//   Q1  profiler visibility: checker worker + marker detector graph nodes.
//
// Every native / IO seam is mocked (established pattern: marker-calibration
// .test.ts); the session runs over a real Channel pair (fake-endpoint).

import { describe, expect, it, vi } from "vitest";
import { Channel, topic, type SessionStatus } from "@lib/orchestrator/protocol";
import { createEndpointPair, flush } from "./fake-endpoint";

// --- controllable seams (hoisted for the vi.mock factories) -----------------
const ctl = vi.hoisted(() => ({
  // registry.acquire: per-test controllable (null = lease failed).
  acquire: undefined as unknown as (serial: string) => Promise<unknown>,
  // calibrateCamera gate — tests park the solve to race it.
  calibrate: undefined as unknown as () => Promise<Record<string, unknown>>,
  // in-memory store
  disk: new Map<string, unknown>(),
  // spies / capture points
  visionWorkers: [] as Array<{ onResult: (r: unknown) => void; init: Record<string, unknown> }>,
  detectors: [] as string[], // MarkerDetector dictionaries, in construction order
  markerResults: [] as unknown[], // what the detector stream yields
  wirings: [] as Array<Record<string, unknown>>, // registerGraphWiring payloads
  wiringDisposed: 0,
  probes: 0,
  probesDisposed: 0,
  reports: [] as string[],
}));

vi.mock("core/Vision", () => ({
  MarkerDetector: class {
    constructor(dict: string) {
      ctl.detectors.push(dict);
    }
    stream() {
      return ctl.markerResults.slice(); // sync-iterable — the loop drains it
    }
    pattern() {
      return Object.assign([[1]], { width: 1, height: 1 });
    }
  },
  calibrateCamera: (..._a: unknown[]) => ctl.calibrate(),
  cornerSubPix: async (_gray: unknown, pts: unknown) => pts,
  resize: async (_m: unknown, { width, height }: { width: number; height: number }) =>
    Object.assign(new Uint8Array(width * height), { shape: [height, width], channels: 1 }),
}));

vi.mock("@lib/marker", () => ({
  CORNER_OBJ_POINTS: [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 0, y: 1, z: 0 },
  ],
  bilinearInterpolate: () => [],
  getInternalObjectPoints: () => [],
}));

vi.mock("@orchestrator/camera", () => ({
  cameraConfigPath: (info: { serial: string }) => ["camera-config", info.serial],
  listCameraInfo: async () => [
    { serial: "CAM1", model: "M1", vendor: "V" },
    { serial: "CAM2", model: "M2", vendor: "V" },
  ],
}));

vi.mock("@orchestrator/registry", () => ({
  acquire: (serial: string) => ctl.acquire(serial),
  // Single-shot retry (the real bounded retry is not under test).
  retryUntil: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@orchestrator/calibration", () => ({
  loadIntrinsic: async () => ({ undistort: null, date: null, rms: null }),
}));

vi.mock("@orchestrator/store-hub", () => {
  const key = (segs: string | string[]) => (Array.isArray(segs) ? segs : [segs]).join("/");
  return {
    read: async (segs: string | string[], fallback: unknown) =>
      ctl.disk.has(key(segs)) ? ctl.disk.get(key(segs)) : fallback,
    write: async (segs: string | string[], value: unknown) =>
      void ctl.disk.set(key(segs), value),
    clear: async (...segs: string[]) => void ctl.disk.delete(segs.join("/")),
    list: async (dir: string) =>
      [...ctl.disk.keys()]
        .filter((k) => k.startsWith(dir + "/"))
        .map((k) => k.slice(dir.length + 1)),
  };
});

vi.mock("@orchestrator/vision-worker-host", () => ({
  createVisionWorker: (init: Record<string, unknown>, onResult: (r: unknown) => void) => {
    ctl.visionWorkers.push({ onResult, init });
    return { sendParams: () => {}, terminate: () => {} };
  },
}));

vi.mock("@orchestrator/graph-topology", () => ({
  registerGraphWiring: (w: Record<string, unknown>) => {
    ctl.wirings.push(w);
    return () => ctl.wiringDisposed++;
  },
}));

vi.mock("@orchestrator/native-probes", () => ({
  registerNativeProbe: () => {
    ctl.probes++;
    return () => ctl.probesDisposed++;
  },
}));

vi.mock("@orchestrator/raw-recording", () => ({
  createRawRecording: () => ({
    active: false,
    node: null,
    start: async () => true,
    stop: async () => true,
  }),
}));

vi.mock("@orchestrator/capture-helper", () => ({
  createCaptureHelper: () => ({
    capturing: false,
    activeCapture: Promise.resolve(),
    build: () => {},
    captureShot: async () => {},
    getPreview: async () => null,
    save: async () => {},
    discard: async () => {},
    stop: async () => {},
  }),
  rawSingleShot: () => null,
}));

vi.mock("@orchestrator/diagnostics", () => ({
  report: (scope: string, message: string) => void ctl.reports.push(`${scope}: ${message}`),
  span: () => {},
  timeSpan: async <T,>(_n: string, fn: () => Promise<T>) => fn(),
}));

import calibrateIntrinsicSession from "@modules/calibrate-intrinsic/session";
import { MIN_SOLVE_SAMPLES } from "@modules/calibrate-intrinsic/contract";
import { INTRINSIC_STORE } from "@lib/calibration-records";

// --- harness -----------------------------------------------------------------

function fakeLease(serial: string) {
  return {
    camera: { serial, stream: {}, pixel_format: "Mono8" },
    release: vi.fn(),
  };
}

const SOLVE_OK = {
  sensor_size: { width: 4, height: 3 },
  camera_matrix: Object.assign(new Float64Array(9), { shape: [3, 3], channels: 1 }),
  dist_coeffs: Object.assign(new Float64Array(5), { shape: [1, 5], channels: 1 }),
  rvecs: [],
  tvecs: [],
  rms: 0.42,
};

async function settle(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}

function harness() {
  // reset controllables
  ctl.disk.clear();
  ctl.visionWorkers.length = 0;
  ctl.detectors.length = 0;
  ctl.markerResults.length = 0;
  ctl.wirings.length = 0;
  ctl.wiringDisposed = 0;
  ctl.probes = 0;
  ctl.probesDisposed = 0;
  ctl.reports.length = 0;
  ctl.acquire = async (serial: string) => fakeLease(serial);
  ctl.calibrate = async () => SOLVE_OK;

  const broker = {
    connect: vi.fn((id: string) => ({
      shmName: `/fv.${id}`,
      spec: { width: 4, height: 3, channels: 4, bytesPerFrame: 48 },
    })),
    disconnect: vi.fn(),
  };
  const session = calibrateIntrinsicSession(broker as never, {} as never);
  const [serverEp, clientEp] = createEndpointPair();
  const server = new Channel(serverEp);
  const client = new Channel(clientEp);
  session.attach(server);
  session.subscribe(server);

  const tele: Record<string, unknown> = {};
  client.on(topic.telemetry("calibrate-intrinsic"), (patch: Record<string, unknown>) =>
    Object.assign(tele, patch),
  );
  let status: SessionStatus = { error: null, progress: null };
  client.on(topic.status("calibrate-intrinsic"), (s: SessionStatus) => (status = s));

  const call = <T = unknown>(cmd: string, arg?: unknown) =>
    client.request<T>(topic.command("calibrate-intrinsic", cmd), arg);
  const setState = (key: string, value: unknown) =>
    client.emit(topic.setState("calibrate-intrinsic"), { key, value });

  /** Push one full-board checker result into the live vision worker. The
   *  kernel reports `size` only when it CHANGES (a size change legitimately
   *  wipes records), so the fake omits it. */
  const checkerResult = (points = [{ x: 1, y: 2 }]) => {
    const w = ctl.visionWorkers[ctl.visionWorkers.length - 1]!;
    w.onResult({
      values: { points },
      frames: [{ name: "gray", buffer: new ArrayBuffer(12), width: 4, height: 3, channels: 1 }],
    });
  };

  return {
    session,
    broker,
    call,
    setState,
    checkerResult,
    tele,
    status: () => status,
  };
}

// --- tests ---------------------------------------------------------------------

describe("select lifecycle (review #5/#15)", () => {
  it("a second select supersedes the first: the late lease is released", async () => {
    const h = harness();
    await h.call("refresh");
    const releases: Array<ReturnType<typeof fakeLease>> = [];
    let releaseGate!: (l: unknown) => void;
    const gate = new Promise((r) => (releaseGate = r));
    ctl.acquire = async (serial: string) => {
      const lease = fakeLease(serial);
      releases.push(lease);
      if (serial === "CAM1") await gate; // first select parks in the lease retry
      return lease;
    };
    const first = h.call("select", { serial: "CAM1" });
    await settle();
    const second = h.call("select", { serial: "CAM2" });
    await settle();
    releaseGate(null); // CAM1's lease resolves LATE
    await Promise.all([first, second]);
    await settle();
    const cam1 = releases.find((l) => l.camera.serial === "CAM1")!;
    const cam2 = releases.find((l) => l.camera.serial === "CAM2")!;
    expect(cam1.release).toHaveBeenCalled(); // superseded → released, not installed
    expect(cam2.release).not.toHaveBeenCalled(); // the winner stays leased
  });

  it("deselect during an in-flight select releases the late lease", async () => {
    const h = harness();
    await h.call("refresh");
    let releaseGate!: (l: unknown) => void;
    const gate = new Promise((r) => (releaseGate = r));
    const lease = fakeLease("CAM1");
    ctl.acquire = async () => {
      await gate;
      return lease;
    };
    const sel = h.call("select", { serial: "CAM1" });
    await settle();
    const desel = h.call("deselect");
    await settle();
    releaseGate(null);
    await Promise.all([sel, desel]);
    await settle();
    expect(lease.release).toHaveBeenCalled();
  });

  it("a failed lease surfaces via the status banner (not a frozen overlay)", async () => {
    const h = harness();
    await h.call("refresh");
    ctl.acquire = async () => null;
    await h.call("select", { serial: "CAM1" });
    await settle();
    expect(h.status().error).toMatch(/Camera unavailable/);
    // A successful retry clears the banner.
    ctl.acquire = async (serial: string) => fakeLease(serial);
    await h.call("select", { serial: "CAM1" });
    await settle();
    expect(h.status().error).toBeNull();
  });
});

describe("records + capture (review #13/#16)", () => {
  it("captures checker records, tracks sampleCount, removes by STABLE id", async () => {
    const h = harness();
    await h.call("refresh");
    await h.call("select", { serial: "CAM1" });
    await settle();
    h.checkerResult();
    await h.call("capture");
    h.checkerResult();
    await h.call("capture");
    await settle();
    expect(h.tele.recordCount).toBe(2);
    expect(h.tele.sampleCount).toBe(2);
    const thumbs = h.tele.records as Array<{ id: number }>;
    // Remove the FIRST record by id — the second must survive (an index-based
    // remove after a concurrent removal deleted the wrong one).
    await h.call("removeRecord", { id: thumbs[0]!.id });
    await settle();
    expect(h.tele.recordCount).toBe(1);
    expect((h.tele.records as Array<{ id: number }>)[0]!.id).toBe(thumbs[1]!.id);
    // Unknown id: idempotent no-op.
    await h.call("removeRecord", { id: 999 });
    await settle();
    expect(h.tele.recordCount).toBe(1);
  });

  it("scale change RESTARTS detection but KEEPS records; pattern change wipes", async () => {
    const h = harness();
    await h.call("refresh");
    await h.call("select", { serial: "CAM1" });
    await settle();
    h.checkerResult();
    await h.call("capture");
    await settle();
    expect(h.tele.recordCount).toBe(1);
    const workersBefore = ctl.visionWorkers.length;
    h.setState("scale", 2);
    await settle();
    expect(ctl.visionWorkers.length).toBe(workersBefore + 1); // detector restarted
    expect(h.tele.recordCount).toBe(1); // records preserved (native rescales corners)
    h.setState("pattern_size", { width: 7, height: 5 });
    await settle();
    expect(h.tele.recordCount).toBe(0); // pattern change still wipes
  });

  it("a stale detection is NOT capturable after a detection restart", async () => {
    const h = harness();
    await h.call("refresh");
    await h.call("select", { serial: "CAM1" });
    await settle();
    h.checkerResult(); // latestChecker set
    h.setState("pattern_size", { width: 7, height: 5 }); // restart → stale corners dropped
    await settle();
    await h.call("capture");
    await settle();
    expect(h.tele.recordCount).toBe(0);
  });

  it("a zero-sample marker capture is refused", async () => {
    const h = harness();
    await h.call("refresh");
    h.setState("method", "MARKER");
    await settle();
    // One detection with a frame but ZERO markers.
    const frame = {
      width: 4,
      height: 3,
      ref: vi.fn(function (this: unknown) {
        return {
          view: async () => Object.assign(new Uint8Array(12), { shape: [3, 4], channels: 1 }),
          release: vi.fn(),
        };
      }),
      release: vi.fn(),
    };
    ctl.markerResults = [Object.assign([], { frame })];
    await h.call("select", { serial: "CAM1" });
    await settle();
    await h.call("capture");
    await settle();
    expect(h.tele.recordCount ?? 0).toBe(0); // nothing committed
  });
});

describe("dictionary change rebuilds the detector (review #1, session half)", () => {
  it("a dictionary state change constructs a NEW MarkerDetector with that dictionary", async () => {
    const h = harness();
    await h.call("refresh");
    h.setState("method", "MARKER");
    await settle();
    await h.call("select", { serial: "CAM1" });
    await settle();
    expect(ctl.detectors).toEqual(["4X4_50"]); // the contract default
    // The renderer's (now-working) selector writes state.dictionary; the watch
    // must restart detection with the new dictionary — this is the path that
    // made the manual's AprilTag workflow function at all.
    h.setState("dictionary", "APRILTAG_36h11");
    await settle();
    expect(ctl.detectors).toEqual(["4X4_50", "APRILTAG_36h11"]);
  });
});

describe("calibrateNow (review #4/#13/#16)", () => {
  async function withRecords(h: ReturnType<typeof harness>, n: number): Promise<void> {
    await h.call("refresh");
    await h.call("select", { serial: "CAM1" });
    await settle();
    for (let i = 0; i < n; i++) {
      h.checkerResult([{ x: i, y: i }]);
      await h.call("capture");
    }
    await settle();
  }

  it("persists the solve as an intrinsic record on success (+ lastRms)", async () => {
    const h = harness();
    await withRecords(h, MIN_SOLVE_SAMPLES);
    await h.call("calibrateNow");
    await settle();
    const keys = [...ctl.disk.keys()].filter((k) => k.startsWith(INTRINSIC_STORE + "/"));
    expect(keys).toHaveLength(1);
    const rec = ctl.disk.get(keys[0]!) as {
      inner: { kind: string };
      outer: { associations: Array<{ cameraKey: string }> };
    };
    expect(rec.inner.kind).toBe("intrinsic");
    expect(rec.outer.associations[0]!.cameraKey).toContain("CAM1");
    expect(h.tele.lastRms).toBe(0.42);
  });

  it("refuses below the minimum-sample floor with a tray-visible message", async () => {
    const h = harness();
    await withRecords(h, MIN_SOLVE_SAMPLES - 1);
    const solve = vi.fn(async () => SOLVE_OK);
    ctl.calibrate = solve;
    await h.call("calibrateNow");
    await settle();
    expect(solve).not.toHaveBeenCalled();
    expect(ctl.disk.size).toBe(0);
    expect(ctl.reports.some((r) => r.includes("refusing to solve"))).toBe(true);
  });

  it("bails (no write, tray message) when the camera changes mid-solve", async () => {
    const h = harness();
    await withRecords(h, MIN_SOLVE_SAMPLES);
    let releaseSolve!: () => void;
    ctl.calibrate = () =>
      new Promise((r) => (releaseSolve = () => r(SOLVE_OK)));
    const solving = h.call("calibrateNow");
    await settle();
    await h.call("deselect"); // the switch — bumps the selection generation
    await settle();
    releaseSolve();
    await solving;
    await settle();
    expect([...ctl.disk.keys()].filter((k) => k.startsWith(INTRINSIC_STORE + "/"))).toHaveLength(0);
    expect(ctl.reports.some((r) => r.includes("mid-solve"))).toBe(true);
  });

  it("is covered by busy() and guards a double-click (one solve at a time)", async () => {
    const h = harness();
    await withRecords(h, MIN_SOLVE_SAMPLES);
    let releaseSolve!: () => void;
    const solve = vi.fn(() => new Promise((r) => (releaseSolve = () => r(SOLVE_OK))));
    ctl.calibrate = solve as never;
    const first = h.call("calibrateNow");
    await settle();
    expect(h.session.busyReason()).toBe("calibration solve in progress");
    const second = h.call("calibrateNow"); // double-click
    await settle();
    releaseSolve();
    await Promise.all([first, second]);
    await settle();
    expect(solve).toHaveBeenCalledTimes(1);
    expect(h.session.busyReason()).toBeNull();
  });

  it("maps an OpenCV rejection to an actionable banner message", async () => {
    const h = harness();
    await withRecords(h, MIN_SOLVE_SAMPLES);
    ctl.calibrate = async () => {
      throw new Error("OpenCV(4.9) assertion failed: objectPoints.size() == imagePoints.size()");
    };
    await h.call("calibrateNow");
    await settle();
    expect(h.status().error).toMatch(/calibrateCamera/);
    expect(h.status().error).toMatch(/re-capture full-board detections/);
    // A later successful solve clears the banner.
    ctl.calibrate = async () => SOLVE_OK;
    await h.call("calibrateNow");
    await settle();
    expect(h.status().error).toBeNull();
  });
});

describe("profiler visibility (review Q1/#15)", () => {
  it("registers the checker worker as a graph node wired to the convert pipe", async () => {
    const h = harness();
    await h.call("refresh");
    await h.call("select", { serial: "CAM1" });
    await settle();
    const wiring = ctl.wirings.find((w) =>
      (w.nodes as Array<{ id: string }>).some((n) => n.id.includes("checker")),
    )!;
    expect(wiring).toBeDefined();
    const node = (wiring.nodes as Array<Record<string, unknown>>)[0]!;
    expect(node.transport).toBe("worker");
    const edge = (wiring.edges as Array<Record<string, unknown>>)[0]!;
    expect(edge.from).toBe("camera/CAM1/convert");
    expect(edge.to).toBe(node.id);
    // Meter name == node id (B-24): the worker self-meter folds onto the node.
    expect(ctl.visionWorkers[0]!.init.meterName).toBe(node.id);
    await h.call("deselect");
    await settle();
    expect(ctl.wiringDisposed).toBeGreaterThan(0); // unregistered on teardown
  });

  it("registers the marker detector node + a JS-side probe (no native probe API)", async () => {
    const h = harness();
    await h.call("refresh");
    h.setState("method", "MARKER");
    await settle();
    await h.call("select", { serial: "CAM1" });
    await settle();
    const wiring = ctl.wirings.find((w) =>
      (w.nodes as Array<{ id: string }>).some((n) => n.id === "camera/CAM1/detect"),
    )!;
    expect(wiring).toBeDefined();
    const edge = (wiring.edges as Array<Record<string, unknown>>)[0]!;
    expect(edge.from).toBe("camera/CAM1");
    expect(ctl.probes).toBe(1);
    await h.call("deselect");
    await settle();
    expect(ctl.probesDisposed).toBe(1);
  });
});
