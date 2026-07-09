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
> DELETED) + `docs/proposals/multi-fovea-recording.md` (SHIPPED 2026-07-09 —
> raw12p packed sensor streams, `fovea.descriptor/v1` data channels, the
> `fovea:wide-camera` singleton, `/codec` compressed pipes; see
> `app/modules/multi-fovea/recording.ts` + `app/orchestrator/{raw-pipe,
> compress-pipe,viewer/decode}.ts`) + `docs/proposals/pairing-nodes.md`
> (SHIPPED 2026-07-09 — L/R exposure pairs feed the descriptor L/R pointers).

## 1. Container

A recording is one **MCAP** file with the **`.fcap`** extension (renamed from
`.fovea` — `standalone-viewer-and-fcap.md` ruling 2; the value lives in
`app/orchestrator/recorder/schema.ts`'s `FOVEA_EXTENSION` export). Legacy
`.fovea` recordings stay **readable** — the viewer open filter, macOS
`open-file`, and the Windows/Linux arg association (`electron/main.ts`) all
accept both `.fcap` and `.fovea`. The container holds channels per recorded
stream,
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

**Channel/payload facts (VERBATIM from the pipe advert — the recorder never
interprets bytes, `multi-fovea-recording.md` rulings 8–10):** each frame
channel's `metadata` carries `{dtype, width, height, channels, pixelFormat,
significantBits, stride}` copied straight from the source pipe. `pixelFormat`
is **opaque** and may be a **packed** wire format (`BayerRG12p` — the
`camera/<serial>/raw12p` container option, 2 samples in 3 bytes, `dtype:"U8"`)
and/or carry a `/codec` **compression suffix** (`BayerRG12p/zlib`); offline
readers split on `/` and decompress right-to-left before interpreting the
base format (per-frame independent blobs, so the container stays seekable —
the exact compressed length rides the ring-v5 slot header, not a dim
computation). Whole-byte formats (the fake rig runs `Mono8`) pack to their
own byte count.

**Non-frame records (multi-fovea):**

- `fovea:wide-camera` (`WIDE_CAMERA_METADATA_NAME`) — a single metadata record
  written once at start: the wide/center camera's intrinsics + distortion
  (`multi-fovea-recording.md` ruling 2). The wide camera is static, so there
  are NO per-frame wide extras.
- `fovea.descriptor/v1` **data channels** — one JSON channel per live target
  (`fovea/<target>`), churned in/out with target arm/disarm. Each doc is
  `{tNs, bbox, frames:{left,center,right}}` where the `frames` values are
  per-stream MCAP **sequence pointers** into the recorded raw streams, and
  are **null-able**: `left`/`right` are non-null only when a trigger-mode
  pairing record bound the observation's exposures (`pairing-nodes.md`
  ruling 1 — free-run recordings always carry `left:null, right:null`);
  `center` is the NEAREST recorded wide frame by timestamp and is explicitly
  UNSYNCHRONIZED (the wide camera is not hardware-triggerable — CAM0 GPIO
  uncabled). Fovea imagery is reconstructed offline from the pointed-at raw
  frames + per-frame params; it is never re-encoded.

**Channel/schema table** (pinned from `docs/schema/fovea.ts`, re-exported by
`orchestrator/recorder/schema.ts` — the writer registers exactly these):

| Channel/topic | Schema | Encoding | Payload |
|---|---|---|---|
| one per recorded stream (topic = stream name, e.g. `camera/<serial>/raw12p`) | `fovea.raw_frame/v1` | `x-fovea-raw` | frame bytes VERBATIM from the pipe; channel metadata = `FRAME_METADATA_KEYS` copied from the advert |
| `telemetry` | `fovea.frame_meta/v1` | `json` | per-frame `{stream, seq, t, ...extras}` (volt/angle/affine — the legacy `.meta` sidecar's `x` payload); correlate by stream+seq |
| `fovea/<target-id>` (one per live target, churned with arm/disarm) | `fovea.descriptor/v1` | `json` | `{tNs, bbox, frames:{left,center,right}}` — see below |

Metadata records (not channels): `fovea:session` (ISO wall-clock anchor at
start), `fovea:wide-camera` (below), `fovea:finalize` (durationSec, written
at finalize — its presence marks a clean close).

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
