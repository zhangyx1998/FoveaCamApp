# Capture & recording nodes — behavior spec

Behavioral contracts for the capture and recorder worker nodes. Source pointers
are given per section; the code carries only load-bearing invariants inline.

## Capture node {#capture-node}

Source: `app/orchestrator/capture-node.ts`

The capture node is a worker thread (vision-worker host pattern — the worker runs
`core/Vision`) that performs the bursty stack/wrap/diff/slice capture math at full
bit depth off the orchestrator main JS loop. The held `pending` resources (16-bit
RGBA foveae, sliced center, diff) live in-worker until `save()`/`discard()`.

### On-demand pipes

Unlike the recorder (one long-lived connection), the capture node is idle between
captures — it holds no pipe consumer connection while parked. `capture()` connects
the raw L/R producers on demand (the injected `acquireStreams` seam:
advertise+attach the `camera/<serial>/raw` producer, refcount++ the broker → the
C-21 gate fires → the capture-thread subscriber is created; see
`core/lib/Aravis/RawPipe.cpp`), drains the burst, then releases (refcount-- → gate
parks → subscriber destructs → zero capture-thread cost). The center view rides the
session's already-connected `undistort:<serial>` pipe (a fresh latest-wins read).

### Pure/tested parts vs worker embed

The pure parts (`grabBurst`, `accumulate`, `manifestOf`, `clampRect`,
`needsDownconvert`) are exported and unit-tested with fakes; the worker embeds them
verbatim via `.toString()` (zero drift), exactly like `recorder-node.ts`'s
`runStreamConsumer`. The eval'd CJS worker source exists because the orchestrator
bundles to a single file, so a sibling worker file would not exist at runtime; the
`core/Vision` + reader-addon entry paths are resolved by the parent and handed in
`workerData`. The image math (stack/makeRGBA/wrapPerspective/diff/slice) is ported
faithfully from the deleted `manual-control/capture.ts` and runs against the
worker's required `core/Vision` — same call sequence, so the saved bytes match the
pre-wave implementation (full-depth parity is the Wave R-3 audit item).

### grabBurst loss contract {#grabburst}

Grab up to `count` consecutive fresh frames in FIFO order, returning the number
actually delivered (`< count` iff the pipe closed early or the deadline passed).
The state machine reuses recorder-node's loss contract, bounded to the burst:

- `null` (torn seqlock read) → retry the same seq
- Closed → stop (producer retired mid-burst — return short)
- NotYet → back off (waiting for the next fresh frame)
- Gone → account `oldest − want` drops, jump to `oldest`
- Ok → deliver, `want = seq + 1`, until `count` delivered

Pure over `cfg`; drives production and the unit tests identically. Write length =
the reader's actual payload length when reported (ring v5), else the advert
fallback — recorder-node parity, so a packed/variable-length payload is byte-exact
and never dim-derived.

### F1 burst timeout

Default `DEFAULT_BURST_TIMEOUT_MS` (10s), overridable per shot via
`CaptureShot.burstTimeoutMs`. On a live rig a raw producer whose gate never fired
(a prior recording retired the shared `camera/<serial>/raw` ids; re-advertise
didn't restart it) leaves `read` forever NotYet — without the deadline the burst
hangs and starves the single-threaded worker (Save never enables). On expiry the
run is abandoned and rejected WITH per-port delivered counts (the stalled port is
named), the host releases the acquired pipes, and `captureBusy` clears. Per-port
progress posts are rate-limited (`PROGRESS_INTERVAL_MS`, 250ms) so a rig watcher
sees which port stalls before the timeout.

### Accumulation semantics

`accumulate`: an `indexed` (raster/multi-shot) resource accumulates as an array
(one entry per shot, in call order); an unindexed resource is a single entry that
replaces. `manifestOf` builds the resource → metadata manifest the renderer reads
(`capture_meta`), preserving insertion order (wide, fovea, center, left, right,
diff).

### Degenerate single-stream mode

Exactly one raw stream is provided (capture-recorder-everywhere ruling 3, item 4).
The worker stacks that one stream full-depth (same stack math, no wrap / center
slice / diff) and holds the result as a single named resource. Used by
calibrate-intrinsic, which leases one camera at a time (never a fixed triple). The
worker dispatches on `"single" in streams`; the host forwards it opaquely.

### Channel order

The three demosaic sites (core `cvtColorCode`, viewer decode, this worker) share
ONE source (`cvBayerPrefix`, `docs/schema`) so the OpenCV↔PFNC off-by-one R/B-swap
can't drift (`channel-order-fix.md`). Held resources are honest RGBA (red = channel
0); `cv::imwrite` wants BGR, so there is ONE honest swap at save — the old
`makeBGR` off-by-one + compensating `RGBA2BGRA` are gone (two cancelling bugs).

### Lifecycle edge cases (host)

- `reading-done`: the burst is fully copied out — park the raw producers now (the
  worker no longer touches the pipes; the stack math finishes off the bytes).
- Worker `"error"`: mark the node stopped so a subsequent `capture()` rejects fast
  without acquiring pipes (posting to a dead worker would leave the run unsettled →
  its raw pipes never release). In-flight runs still release + reject. No respawn
  (session teardown owns that).
- `capture()` while stopped: reject before acquiring any pipes.

## Recorder node {#recorder-node}

Source: `app/orchestrator/recorder-node.ts`, `app/orchestrator/recorder/*`

The recorder node is a thin driver over the native recorder brick (`core.Recorder.*`
— `core/lib/Record/RecorderStream`). The brick owns the whole write path in C++:
producer-seam record taps on the same pipes this node used to FIFO-read (raw camera
publishers, `CompressStream` /zlib outputs, derived bricks — advert-verbatim,
byte-for-byte what the ring carried), bounded drop-oldest queues, and a free-running
writer thread hosting the hand-rolled McapWriter (`docs/proposals/native-recorder.md`).
Nothing per-frame crosses JS in either direction — the host polls stats + ruling-3
frame notices on a low-rate timer and forwards extras back as native enqueues.

### What the host owns

- The broker pipe connects (refcount++ → C-21 gate → producer runs) and their
  release ordering (tap detach is synchronous, so `removeStream` releases its pipe
  immediately — no async stream-ended dance).
- The `recorder/<session>` graph row + workload meter, fed by `foldStreamStats` over
  the brick's cumulative counters (same `StreamCounters` shape, same F2 drop
  attribution).
- The ruling-3 extras round-trip (`dispatchFrame` over drained notices →
  `appendTelemetry`).
- The container-layout inputs (`schema.ts` constants + advert-verbatim channel
  metadata) — passed into the brick so `docs/schema` stays the single source of truth.

The pure parts (`foldStreamStats`, `dispatchFrame`) stay exported and unit-tested
with fakes; the native seam is injected so vitest never loads native core. `SeqRead`
stays exported for `capture-node.ts` (its bounded FIFO consumer still reads pipes in
a JS worker — a legitimate SHM/JS boundary; `core/test/29-raw-pipe.ts` is canonical).

### Counter invariants

`StreamCounters` are monotonic totals: `written + dropped == ingested`,
`droppedQueue + droppedRing == dropped`. F2 attribution splits drops into
`queue-overflow` (shed while the writer was mid-encode/write — tune queue cap / write
batching) and `ring-recycled` (shed while the writer was between items — an arrival
burst outran the drain). They sum to the old single "ring-recycled" total, so the
drop invariant is unchanged.

### Two clocks

Every native frame notice carries two clocks:
- `logTimeNs` — the container time axis the frame was written at (the brick's steady
  clock, shared across every channel; the telemetry doc MUST reuse it as its message
  `logTime` so the viewer's relative-time seek domain stays single-clock — see
  `viewer/source.ts`).
- `tNs` — the frame's trusted capture time (device time when stamped, else equal to
  `logTimeNs`); the FIN-correlation value carried in the telemetry doc's `t` field
  (in seconds).

`dispatchFrame` builds the telemetry doc `{stream, seq, t, ...extras}` and posts it
with the owning frame's `logTimeNs`. A late/absent callback reply just means the
frame carries no extras, never a stall.

### Format-agnostic socket

The recorder never parses advertised format strings (ruling 8): `pixelFormat` (may
carry codec suffixes like "BayerRG12p/bz2"), `stride`, and `significantBits` are
copied verbatim into channel metadata, never derived from a name (a codec-suffixed
name would defeat the registry lookup). `channelMetadata` is shared by initial and
churned streams so nothing diverges.

### FoveaDescriptor pointers

Frame pointers are nullable (wave I-2): free-run recordings carry left/right = null
(no trigger-mode pair bound the exposure, pairing-nodes ruling 1); an evicted/
unmatched key is likewise null rather than absent. Offline readers treat null and
missing identically.

### Finalize deadline

`stop()` finalizes with an R-2 hard deadline (`finalizeDeadlineMs`, default 30s): a
wedged writer must never hang session teardown / hardware quiescence. On expiry the
host logs, aborts the native recorder (crash-shape container left on disk — the
documented contract), releases the pipes in order, and returns truncated stats
(`truncated: true`, per value-sweep-2026-07-11 so the recording service surfaces it
instead of publishing a clean stop). A writer wedged in a syscall keeps its handle
(leaked — process exit recovers). Build-failure unwind (20e8834 discipline): never
leave a connected pipe behind a throw — the node's connects are the node's to release.

## Recorder sink facade {#recorder-sink}

Source: `app/orchestrator/recorder/*`
(`docs/history/refactor/recorder-container.md` §2 decision + §3)

Writes a single `.fovea` container (standard MCAP inside) through one worker_threads
writer per topology key (`singleFileTopology` today: exactly one worker, one file). The
legacy `.stream`/`.meta`/manifest backend + its `RECORDER_BACKEND` selector were dropped
(capture-recorder-nodes ruling 6); this MCAP sink is the only backend.

Live manual-control recording no longer flows through this sink — it flows through the
recorder NODE (`recorder-node.ts`, native brick). This sink + `McapWriterWorker` remain
as the container-writing surface the recorder bench + tests drive directly.

### Container layout

- One channel per recorded stream, `messageEncoding: "x-fovea-raw"` — message bytes are
  the frame exactly as captured (12p stays packed); channel metadata carries the static
  decode props (dtype/shape/pixelFormat/significantBits/channels), taken from the
  stream's first frame.
- One `telemetry` channel (JSON): per-frame extras (volt/angle/homography, the legacy
  sidecar's `x` payload) sent only for frames that have extras, correlated by
  stream+seq (or logTime).
- MCAP metadata records `fovea:session` (ISO timestamp) and `fovea:finalize`
  (durationSec).

### Timestamps

logTime/publishTime are nanoseconds on the same clock the legacy writer used
(`performance.now()/1000` seconds) — relative to process start, monotonic across every
channel of a session; the absolute wall-clock anchor is the `fovea:session` metadata
record.

## Capture helper (composable facility) {#capture-helper}

Source: `app/orchestrator/capture-helper.ts` (capture-recorder-everywhere ruling 3)

Lifts the capture machinery that used to live inline in `manual-control/session.ts`
(createCaptureNode wiring, the on-demand per-shot raw L/R advertise+connect, the
captureBusy/capture_meta telemetry, the captureShot/getPreview/save/discard command
surface, and the recording-vs-capture exclusivity guard) so any triple-holding session
opts in with config (its held L/R cameras, its live center pipe, an app-specific per-shot
snapshot, and its recording service's `active` flag).

The extraction is faithful to manual-control: same on-demand acquire sequence with the
reverse-order error unwind (a mid-sequence throw never orphans a refcount →
camera-exclusivity hazard), the same F1 burst-timeout semantics (owned by the capture
NODE — the helper forwards `snapshot()`'s optional `burstTimeoutMs`), and the same
exclusivity refusal (capture refused while a recording holds the shared
`camera/<serial>/raw` ids).

Naming (planner ruling): the contract mixin names are `captureShot` / `getCapturePreview`
/ `saveCapture` / `discardCapture` (+ `captureBusy` / `capture_meta` telemetry) —
collision-free with app-local commands (calibrate-intrinsic already has a `capture`).
manual-control keeps its legacy `capture`/`getPreview` names aliased to this same helper.

## Recording service (composable facility) {#recording-service}

Source: `app/orchestrator/recording-service.ts` (capture-recorder-everywhere ruling 1)

The per-app recording controllers were ~90% the same shape: a `start`/`stop` around the
recorder NODE lifecycle, a 250ms stats poll, the `recording_active` / `recordingStreams`
telemetry (including the F2 drop-cause split, carried verbatim in `RecorderStreamStats`),
and the acquire-then-build error-path unwind discipline (20e8834). That skeleton lives
here once; each app passes config (guard, resource acquisition + node options, optional
start/stop hooks) and keeps only its own semantics (fovea binding, descriptor channels,
compression routing, path policy).

The recorder is an advert-verbatim socket, so the facility never interprets a pipe — the
app's `acquire` decides which pipes to record (advert-verbatim, /zlib siblings, extras
streams) and returns the assembled node options plus a `release` closure that unwinds
every acquired resource in reverse (bricks-before-raw). The facility owns exactly one
throw path: if the native recorder-node build throws after a successful acquire (worker
spawn / broker connect), it releases via that closure and rethrows — never leaving an
orphaned refcount (camera-exclusivity hazard) with the controller idle.

## Recorder sink writer {#recorder-writer}

Source: `app/orchestrator/recorder/writer.ts`

Main-thread host for one recorder worker (one McapWriter, one container file): a
worker_threads worker fed by transferred ArrayBuffers, bounded queue, fail-fast on worker
error, multiplexing N channels into a single file, metered from day one. (The live
recording path is the recorder NODE; this sink writer remains the container surface the
recorder bench + `test/recorder.test.ts` container-contract tests drive directly.)

Backpressure contract (recorder-container.md §3): the orchestrator loop must never block on
the recorder. `writeFrame` is synchronous and never awaits — when a channel's in-flight
window is full the frame is REFUSED (returns false) and accounted as a drop; the payload
thunk is not even invoked, so no copy is wasted on a frame that won't ship. Drops are data,
not silent: they land in the workload meter (`byReason` backpressure/failed) and the
caller's per-stream stats. The class is deliberately core-free (bytes in, bytes out) —
Mat/PixelFormat handling lives in the sink layer (`index.ts`).

## Recorder worker source {#recorder-worker-source}

Source: `app/orchestrator/recorder/worker-source.ts`

Source string for the recorder sink's worker_threads worker — eval'd CJS (the orchestrator
bundles to a single file, so a separate worker source file would not exist at runtime).
`@mcap/core` cannot be require()d by bare name from an eval worker (its `require` resolves
against the process cwd, not the app dir in packaged builds) — the parent resolves the real
entry via `createRequire(import.meta.url)` and passes it in `workerData`.

One McapWriter per worker, multiplexing every registered channel into one file. McapWriter
is documented non-reentrant ("wait on any method call to complete before calling another"),
so every operation (init, channel registration, frame/meta writes, finalize) is serialized
through a single promise chain (`chain = chain.then(...)`). Message order on the port is
preserved, so a "channel" registration posted before that channel's first "frame" runs
first. Protocol: see `types.ts` (RecorderWorkerIn / RecorderWorkerOut).

## Raw-recording helper {#raw-recording}

Source: `app/orchestrator/raw-recording.ts` (capture-recorder-everywhere ruling 2)

Shared "record the app's raw camera streams" config over the recording facility. Most apps
that gain recording (disparity-scope + the four calibrate wizards) have no per-frame fovea
binding to inject — they just want the obvious default recordable set: the full-bit-depth
`camera/<serial>/raw` sensor stream(s), advert-verbatim. This helper wraps that case so each
app opts in with a `cameras()` accessor and a `finished` notifier instead of re-deriving the
raw-pipe acquire + connect + error-unwind config.

It reuses manual-control's exact raw-pipe acquire (the unpacked 16-bit container, deep
recorder ring) + the ruling-8 significantBits connect injection. No `onFrame`: these
recordings carry no per-frame extras (the app holds no controller pose bound to the frame) —
the container is the raw sensor stream only, honest and reconstructable.

## Recording-compression setting {#record-compression}

Source: `app/orchestrator/record-compression.ts` (user directive 2026-07-09)

The app-level recording-compression setting, orchestrator side. Reads the configured method
from the shared `["config"]` document at RECORDING START (the store-hub read pattern, NOT
`@lib/config`, which pulls Vue into this Vue-free process). Applies to NEW recordings; a
running recording keeps the method it started with. The union + default + validation live in
the shared Vue-free `@lib/config-schema` (the same source `@lib/config`'s renderer half
consumes), so the two can never drift.

## Per-frame recorder metadata {#recorder-metadata}

Source: `app/orchestrator/recorder/metadata.ts` (WS4 4b)

Per-frame recorder metadata schema. The `.fovea` `telemetry` channel carries one JSON
document per frame that has extras — `{stream, seq, t, ...extras}`, correlated to its raw
frame by (stream, seq). This module pins the DECODER-FACING shape of those extras
(pyfovea/viewer read them) and the builder for the frame↔voltage binding.
`RecordingSink.write(extra)` stays generic (`Record<string, unknown>`) so unknown keys still
pass through — this schema documents the BLESSED keys, it does not gate them.
