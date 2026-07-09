# The `.fovea` recorder container and viewer

> Source of truth: `app/orchestrator/recorder-node.ts` (the recorder THREAD
> NODE — one worker: FIFO pipe consume + MCAP encode/write) +
> `app/orchestrator/capture-node.ts` (its capture sibling),
> `app/orchestrator/recorder/*` (the container/writer contract surface),
> `app/modules/manual-control/recording.ts` (streams map + extras callback),
> the `viewer` session + `app/src/windows/ViewerWindow.vue`,
> `app/lib/orchestrator/viewer-contract.ts`. Design + rulings:
> `docs/proposals/capture-recorder-nodes.md` (SHIPPED 2026-07-09/10 — named
> raw FIFO pipes, per-frame `onFrame(stream, seq, deviceTs)` extras callback,
> capture `onCaptureStart` once per run, pull-based capture previews,
> auto-open viewer on `recording:finished`; legacy `.stream`/`.meta` backend
> DELETED).

## 1. Container

A recording is one **MCAP** file (`.fovea`): channels per recorded stream,
schemas pinned by the writer (the schema contract is the compatibility
promise for offline consumers — change it deliberately or not at all).
Per-frame metadata binds each fovea frame to its **voltage provenance**:

- `volt.source: "fin-averaged"` — a hardware-triggered capture matched to
  this frame: the FIN's exposure-AVERAGED mirror voltage + `frame_id`
  (`serial-protocol.md`), the authoritative binding.
- `volt.source: "live-snapshot"` — free-run frames stamped with the session's
  current commanded volts.

Angles/homography snapshots ride the same per-frame metadata so recorded
frames are reconstructable without the live calibration.

*(Planner-review stub: the exact channel/schema table is B-owned — transcribe
from the writer's schema registry in `orchestrator/recorder/` when pinning
this section.)*

## 2. Write path

Recording runs in a dedicated worker thread; the session hands frames off and
the worker owns encoding + file I/O. Backpressure is drop-accounted, never
blocking: a `recorder:<name>` workload meter (`metering.md`) counts
throughput and reason-bucketed drops, so a recording that can't keep up is
visible in the profiler instead of stalling the frame path.

## 3. Viewer

`.fovea` files open in a **viewer window** — 0..N windows, exactly one per
file (`fileKey` dedupe, `windows.md`). A `viewer:<fileId>` orchestrator
session replays the container (decode + seek) and serves frames/metadata over
the standard session channel; the window is a normal passive client.

## 4. Python access

Offline analysis reads `.fovea` directly with any MCAP library — the schema
contract in §1 is the stability promise. The bench tooling under
`playground/bench-recorder/` exercises the container end-to-end.
