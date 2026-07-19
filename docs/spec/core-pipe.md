# core SHM producer/publisher pipe

Behavior spec for `core/include/Pipe.h` + `core/src/Pipe.cpp` (`namespace Pipe`).
Invariant: SHM rings are IPC / JS-worker boundaries ONLY; brick→brick handoffs
never read the ring. The code carries `// spec:` pointers to the anchors below.

## seam {#seam}

A *pipe* is one typed producer output. Its `Publisher` owns a `ShmRing` segment;
N consumers read the latest producer frame via the reader addon. A
`FrameProducer` feeds one publisher 1:1 through a latest-wins handoff. The
publisher is convert-agnostic: producers deliver frames ALREADY CONVERTED to the
pipe's advertised format (e.g. BGRA8); the publisher stays raw-memcpy + seqlock.
The orchestrator brokers a ONE-TIME connect handshake — nothing per-frame crosses
JS. A C++ producer obtains its sink via `PipeHub::instance().sink(pipeId)`.

COLLAPSED: there is NO separate publisher thread — `offer()` seqlock-writes
the frame directly ON THE PRODUCER'S thread (already off the JS loop). Single
writer to the ring (1:1 producer↔pipe).

## sizing {#sizing}

The ring is sized to a tunable per-FOVEA max (NOT the camera resolution — a
fovea is a small hi-res crop, so N max rings stay bounded); each frame carries its
own active w/h ≤ max. Camera pipes: `max == fixed`. `PipeSpec.maxBytes` is the
slot size (defaults to `bytesPerFrame`); a renderer read must provision `maxBytes`
(slot size), NOT nominal `bytesPerFrame`.

`FrameInfo` fields:
- `stride` = bytes per row of `data` (`cv::Mat::step`); may exceed `width*channels`
  (the publisher copies row-by-row into the tight slot).
- `originX/originY` (v4): a crop's FRAME-BOUND position within its
  parent stream (fovea nodes). Uncropped producers leave 0/0.
- `bytesPerElement` (`cv::Mat::elemSize1()`): 1 for U8 frames (default), 4 for a
  CV_32FC1 disparity map. The tight-packed row/active-byte math multiplies by
  this so a non-U8 mat publishes without truncation. Additive: default 1 keeps
  every U8 producer byte-for-byte unchanged.
- `payloadBytes` (v5): an OPAQUE variable-length
  payload (compression bricks). When nonzero, `offer()` copies exactly
  `payloadBytes` contiguous bytes from `data` (ignoring stride/rows) and records
  the length in the slot header — `width/height/origin` still carry the SOURCE
  frame's identity. 0 = a normal dim-derived frame (unchanged).

`offer()` is latest-wins, non-blocking, thread-safe. A frame whose active size
exceeds the ring slot is dropped (a bookkeeping drop, never a throw).

## refcount-gate {#refcount-gate}

`connect()`/`disconnect()` maintain the consumer refcount. At zero the ring write
pauses (segment stays mapped/advertised — reconnectable). The 0↔1 edges fire the
`ConsumerGate`, which drives the converter subscribe/unsubscribe — the
SINGLE gate for "idle when no pipe open". `setConsumerGate` fires
`gate(refcount>0)` IMMEDIATELY on registration (reconciling a consumer that
connected first), then on each edge. NAPI-thread only.

## quiesce {#quiesce}

`quiesceConsumers()` is a defense-in-depth teardown backstop, fired by
`PipeHub::drop` BEFORE the Publisher (segment unmap) is destroyed. Producer
bindings in SEPARATE registries (RawPipe / Converter / Compress) cache the
Publisher's raw `FrameSink*` and only release their gated subscriber on a
consumer-gate→0 edge or explicit detach — so a `drop()` BEFORE detach would leave
a live subscriber offering into freed memory on the capture/convert thread. This
synchronously fires the consumer gate OFF, making the guarantee STRUCTURAL rather
than reliant on the detach-before-unadvertise JS convention. No-op if no gate is
registered; NAPI-thread only; idempotent.

## record-tap {#record-tap}

`RecordTap` is an in-process tap at the publisher seam (native-recorder). Fired on
the PRODUCER'S thread for every frame the ring accepts (after validation, ≥1
consumer connected, pipe open) with the producer's ORIGINAL (possibly strided)
buffer — exactly the payload the ring records, so a recorder tapping here captures
byte-for-byte what a ring consumer would read (advert-verbatim, v5 opaque payloads
included). The callee MUST copy synchronously (the buffer is reused) and MUST
NEVER block (it runs on the capture/convert/compress thread) — a bounded
drop-oldest enqueue only. This is a brick→brick handoff (rings are IPC/JS
boundaries ONLY; the native recorder never reads the ring).

`addRecordTap`/`removeRecordTap` are keyed by an opaque `token`. `offer()` holds
`tapMutex_` across tap calls, so `removeRecordTap` returns only after no in-flight
tap invocation can still run — the owner may free capture state immediately after.
`hasTaps_` gates the lock acquisition so untapped pipes pay one relaxed atomic
load per frame.

## epoch {#epoch}

`advertise` is idempotent for a LIVE id (returns its current epoch). A first
advertise, or one after `drop`, bumps a per-id epoch → a NEW segment name
(`/fv.p<hash>.g<epoch>`), so a stale consumer on the old segment sees CLOSED and
never binds the reused id. Epochs persist across `drop`.

`bytesTotal()` is the total ACTIVE bytes ring-written since advertise — one
add per successful offer, so the topology's per-edge MB/s is exact even for
variable-size fovea frames (rate × nominal would lie). Monotonic; relaxed atomic
(single producer-thread writer, any-thread reads); the reader diffs snapshots.
