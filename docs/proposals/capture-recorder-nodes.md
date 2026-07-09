# Capture + recorder as thread nodes (named streams, metadata callbacks, raster capture)

Status: **RULED** (user, 2026-07-09) — design sketch for review; phases below
are planner checkpoints, not yet dispatched.

## The rulings (user, 2026-07-09, verbatim intent)

1. **Move the capture/recorder core logic to the orchestrator so they run as
   a thread node.** (The logic is already orchestrator-side but consumes
   frames on the MAIN JS loop — `lease.camera.stream` iterators in
   `manual-control/capture.ts` + `recording.ts`. "Thread node" = the
   established pattern: frames flow in a dedicated thread, the node
   self-meters, and it appears in the profiler graph.)
2. **They accept NAMED frame streams** (a `name → stream` map; the names are
   the container channel / capture resource names).
3. **JS callback interface for the session server to inject additional
   metadata gathered from other nodes:**
   - **Capture: callback once upon capture START** — no matter how many
     frames are stacked into that capture.
   - **Recorder: callback once per NEW frame**, identifying the frame's
     source name and timestamp.
4. **Raster capture (manual-control):** a "Raster Capture" button in the
   drawer + an **async `capture()` callback exposed to the renderer**, so the
   renderer can set up fovea positions between each capture.

## Where the code is today (facts)

- `modules/manual-control/recording.ts`: three JS taps on the raw L/C/R
  camera streams (main loop) → bytes extracted → transferred to the MCAP
  writer worker (`orchestrator/recorder/writer.ts`). Only the FILE I/O is off
  the loop; the per-frame consume/copy/transfer is main-thread.
- `modules/manual-control/capture.ts`: bursty stack/wrap/diff at full bit
  depth (`core/Vision` calls) ON the orchestrator main thread; pending
  resources held in session memory; 8-bit previews republished.
- SHM pipes are seqlock LATEST-WINS (no FIFO variant) and today carry only
  converted/derived frames — there is NO raw full-depth pipe. Recording
  writes raw sensor bytes ("12p stays packed") and capture stacks at 16-bit,
  so BOTH nodes need a raw frame path, not the BGRA8 pipes.
- Vision workers already connect + poll pipes in their own worker threads
  with maxBytes provisioning and seq-gap detection — the consumption pattern
  to reuse.
- The FIN-averaged voltage binding (stage-F, `FoveaBinding.source: "fin"`) is
  typed but unimplemented — ruling 3's per-frame callback is exactly its
  future injection point.

## Design (pinned)

### Phase 1 — raw pipes (core, the enabler)

A `RawPipePublisher` on the camera source brick, the `PipeOfferSubscriber`
pattern applied to raw `Frame`s: publishes the sensor bytes EXACTLY as
captured (packed 12p preserved; `pixelFormat` = the sensor format string,
`dtype` per container width, stride/bytesPerFrame from the frame). Node id
`camera/<serial>/raw`; consumer-gated like every pipe (no recorder/capture
attached → zero cost). Pipes are opaque bytes + dims, so NO pipe-contract
change — only a new attach fn + typings (planner-owned graph-contract needs
nothing; `nodeId` gains nothing — reuse the `<sourceId>/<kind>` id shape
composed in the session wrapper).

Loss semantics (pinned): seqlock latest-wins + a consumer polling ≥ 2× frame
rate + seq-gap DROP ACCOUNTING. Recording is drop-accounted today (never
blocking), so this does not regress the contract; a lossless SHM FIFO queue
is noted as a hardening follow-up if the rig shows gap losses at full rate.

### Phase 2 — recorder node (worker thread)

`orchestrator/recorder-node.ts`: ONE worker thread that owns the whole write
path — connects the named pipes (`{name → pipeId}`, raw or derived), polls
them in its own loop (vision-worker consumption pattern), and hosts the
existing `RecordingSink` facade INSIDE the worker (MCAP writer becomes
in-worker; the legacy `.stream` backend rides along unchanged behind
`RECORDER_BACKEND`). The container layout/schema contract is UNCHANGED.

- **Graph node** `recorder/<session>` (kind `"recorder"`): input edges from
  each named source pipe (port = stream name), meters = per-stream ingest
  rate + reason-bucketed drops + write bytes/s. Replaces the current
  `recorder:<name>` bare workload meters with a real node row.
- **Ruling-3 callback**: on each NEW frame the worker posts
  `{stream, seq, deviceTimestamp}` to the session's registered
  `onFrame(stream, tNs)` handler; the handler returns the extras object
  (volt/angle/homography — and later the FIN binding) or null. The frame
  channel message is written immediately (never blocked on JS); the extras
  ride the `telemetry` channel correlated by stream+seq — exactly the
  current container semantics, so a late/absent reply degrades to a frame
  without extras, never a stall.
- Session surface: `createRecorderNode({ id, streams, path, backend })` →
  `{ onFrame(cb), stats(), stop() }`. `manual-control/recording.ts` shrinks
  to: build the streams map (raw L/C/R pipes), register the extras callback
  (reusing `resolveFoveaBinding`/conv snapshots), mirror stats into the
  existing `recordingStreams` telemetry shape (RecordButton UI unchanged).

### Phase 3 — capture node (worker thread, bursty)

`orchestrator/capture-node.ts`: a worker thread (vision-worker host pattern —
workers already run `core/Vision`) that connects the same named raw pipes.
Idle between captures (consumer-gated pipes park). On `capture(params)`:

- **Ruling-3 callback FIRST**: `onCaptureStart()` fires ONCE per capture run
  — the session snapshots its metadata (volts, setpoint, angles, conv) and
  returns it; the snapshot is attached to the whole capture regardless of
  stack depth.
- The worker drains N frames per named stream (the existing `capStack`
  count), does the stack/wrap/diff at full bit depth IN-WORKER, holds the
  pending resources IN-WORKER, and posts back 8-bit preview payloads (the
  same downconverted previews the renderer sees today).
- `save(path, format)` / `discard()` forward to the worker (file I/O
  in-worker). Indexed-resource accumulation semantics (one entry per
  setpoint, "wide" captured once) are preserved but move behind the node's
  accumulate API so ruling 4's renderer-driven loop composes them shot by
  shot.
- **Graph node** `capture/<session>` (kind `"capture"`): input edges from the
  named pipes; meters = per-capture burst counts + stack timing. Parked =
  honest zero.

### Phase 4 — raster capture (manual-control UI, ruling 4)

- The session `capture` command becomes PER-SHOT and awaitable: it resolves
  when the capture node has stacked + held that shot (the old `runCapture`
  internal setpoints loop is REPLACED by renderer sequencing; the command
  keeps an optional setpoint tag so indexed resources accumulate exactly as
  before).
- Renderer (`manual-control/index.vue` + drawer): a **"Raster Capture"**
  button in the drawer. Its handler iterates the raster grid of fovea
  positions: set the set-point volts (existing state/commands) → settle →
  `await session.call("capture", { tag })` → next cell; then the normal
  SaveControls flow commits (or discards) the accumulated indexed resources.
  Abortable mid-raster (Escape/second click) → `discard()`.
- The plain capture button keeps working as a 1-shot raster.

## Open questions (veto points before dispatch)

1. **Loss contract**: is drop-accounted latest-wins polling acceptable for
   the recorder at target rates, or is the lossless SHM FIFO queue required
   up front? (Pinned above as acceptable-with-accounting; FIFO is a
   follow-up.)
2. **Raster grid definition**: renderer-defined loop (pinned — max
   flexibility, matches ruling 4's "renderer can setup fovea positions"), or
   should the grid (rows × cols × bounds) also live in session state so
   headless/scripted rasters work later?
3. **Legacy backend**: keep `.stream`/`.meta` behind `RECORDER_BACKEND`
   inside the worker (pinned), or drop it this wave?
4. **Preview channel**: capture previews keep riding session frames (pinned,
   zero renderer change) vs becoming pipes.

## Rig items (stage-f, accumulated at dispatch)

Recorder node records L/C/R at full rate with the graph row live (ingest ≈
camera rate, drops ≈ 0 on an idle machine); `.fovea` output byte-compatible
with the previous writer (bench-recorder pass); capture parity (same
resources, full bit depth) vs a pre-wave capture; raster capture: N-cell grid
→ N indexed resources with per-shot metadata snapshots; orchestrator main-loop
utilization flat while recording (the point of the wave).
