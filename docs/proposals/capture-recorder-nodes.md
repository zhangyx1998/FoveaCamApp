# Capture + recorder as thread nodes (named streams, metadata callbacks, raster capture)

Status: **RULED** (user, 2026-07-09) — design sketch for review; phases below
are planner checkpoints, not yet dispatched.

## Rulings round 2 (user, 2026-07-09 — veto answers + scope)

5. **Pipes support FIFO mode — implement FIRST if absent.** (Verified absent;
   Phase 0 below.)
6. **Drop ALL legacy interfaces** (the `.stream`/`.meta`/manifest backend,
   `RECORDER_BACKEND`, `orchestrator/recorder/legacy.ts`, the old
   `stream-writer.ts` path, the no-op `Delegation` capture prop mechanism).
7. **Capture preview uses ACTUAL data, gathered from the node** — the
   renderer pulls the node's real held resources; no separate republished
   preview stream.
8. **Capture preview moves into its OWN window**; **recording preview (the
   playback/viewer window) opens automatically when a recording finishes**
   (the viewer window + session already exist — wire the auto-open).
9. **Revive stalled items**: the FIFO queue (was "hardening follow-up" → now
   Phase 0); the Cmd/Cmd-R `recorder:trigger` stub ("real semantics land with
   the recorder stage" — this IS the recorder stage: Cmd-R toggles recording
   where a recording context exists). The FIN-averaged voltage binding stays
   hardware/firmware-gated (stage-f) — its injection point is ruling 3's
   per-frame callback.
10. **Drain the whole plan** — dispatch aggressively, keep going until every
    phase lands.

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

### Phase 0 — FIFO pipe read mode (core, FIRST — ruling 5)

The v4 SHM layout already carries what FIFO needs: per-pipe `slotCount`
(ring depth, up to `MAX_SLOT_COUNT` 64), per-slot seqlock'd `SlotHeader.seq`,
and `latestSeq` — the writer round-robins slots by seq. FIFO is therefore a
CONSUMER-SIDE read mode; the writer path does not change:

- `readSeqInto(mapping, wantSeq, dst, ...)` in the read TU: locate slot
  `wantSeq % slotCount`, seqlock-read it, and classify: **Ok** (slot held
  `wantSeq`), **NotYet** (`wantSeq > latestSeq`), **Gone** (slot already
  recycled — return the oldest still-live seq so the consumer JUMPS and
  accounts `wantSeq..oldest-1` as drops). Never blocks the writer; loss
  happens only when the consumer lags a full ring (depth = the hwm), and is
  always accounted.
- Consumer surfaces: the JS `shm-client` gains `readPipeSeq(shmName, seq,
  bytes)` beside `readPipe` (same maxBytes slot-size provisioning — the C-20
  rule); worker-side consumption loops on `lastSeq+1` with `NotYet` →
  short-poll/backoff, `Gone` → jump + drop-account.
- Advertise: `PipeSpec.ringDepth?` (default today's 3) so FIFO consumers can
  request deep rings (recorder: 32–64); plumb through the broker advertise
  path. No new pixel semantics.
- Test: a core test proving ordered lossless delivery through a deep ring
  under a slow consumer, the Gone/jump accounting, and that latest-wins
  readers of the SAME pipe are unaffected.

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

Loss semantics (RULED round 2): recorder/capture consume raw pipes in FIFO
mode (Phase 0) with deep rings — lossless up to ring depth, drop-accounted
past it, writer never blocked.

### Phase 2 — recorder node (worker thread)

`orchestrator/recorder-node.ts`: ONE worker thread that owns the whole write
path — connects the named pipes (`{name → pipeId}`, raw or derived) in FIFO
mode (Phase 0), reads them in its own loop, and hosts the MCAP writer
in-worker. The container layout/schema contract is UNCHANGED. **Legacy is
DELETED (ruling 6)**: `recorder/legacy.ts`, `RECORDER_BACKEND`, the
`.stream`/`.meta` sink, and `orchestrator/stream-writer.ts` + its worker
source go away (grep for external references first; the external decoder
tooling concern is superseded by the ruling).

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
- **Preview = the node's ACTUAL data (ruling 7)**: no republished preview
  stream. The renderer PULLS previews via a session command
  (`getPreview(resource, index?)`) that the node answers from its real held
  resources (downconverting full-depth → displayable 8-bit on demand,
  in-worker). What you see is byte-derived from what will be saved.
- **Capture preview window (ruling 8)**: the preview + SaveControls/
  SaveReport UI moves OUT of the title-bar overlay into its own window —
  reuse the module-debugger substrate (`debug` class registry pattern) or a
  sibling `capture-preview` keyed toggle window owned by the app window
  (cascade on close). Opens on capture completion (and via a button);
  save/discard live there. The old `Overlay`+`current_capture` title-bar
  camera icon and the no-op `Delegation` prop mechanism are DELETED
  (ruling 6).
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
- **Cmd/Ctrl-R revival (ruling 9)**: the renderer finally consumes
  `onRecorderTrigger` — where a recording context exists (manual-control),
  Cmd-R toggles start/stop recording (RecordButton's exact action); no-op
  chirp elsewhere.

### Phase 5 — playback window + auto-open (rulings 8/9)

The `.fovea` viewer window + `viewer` session ALREADY EXIST (one window per
file, ns seek, standard frame transport). This phase: (a) verify playback
against the new recorder node's output (container contract unchanged, so
this is a regression check + fixes if drift is found); (b) **auto-open**: when
`stopRecording` finalizes, the session notifies main (bridge push) and main
calls the existing `openViewer(path)` — the finished recording's preview
appears without user action.

## Veto points — ANSWERED (user, round 2)

1. Loss contract → **FIFO pipes, implemented first** (Phase 0).
2. Raster grid → renderer-defined loop (unchallenged — stays pinned).
3. Legacy backend → **dropped entirely** (ruling 6).
4. Preview channel → **pull actual data from the node** (ruling 7).

## Execution (ruled): interleave refactor and review/optimization waves

Waves alternate: each implementation wave is followed by a REVIEW +
OPTIMIZATION wave (fresh-eyes worker audit of the just-landed code against
this proposal + the standing invariants, plus a perf pass: main-loop
utilization, per-frame allocations, meter overhead) before the next
implementation wave dispatches. Planned order:

1. **Wave I-1** (impl): Phase 0 FIFO + Phase 1 raw pipes (core, one worker)
   ∥ the window-substrate half of Phase 3/5 (capture-preview window shell,
   viewer auto-open plumbing, Cmd-R consumer — app-side, disjoint files).
2. **Wave R-1** (review/opt): audit FIFO memory ordering + ring recycling,
   raw-pipe zero-copy path, window-substrate lifecycle; optimize hot spots.
3. **Wave I-2** (impl): Phase 2 recorder node + legacy deletion.
4. **Wave R-2** (review/opt): recorder soak (synthetic fake-camera run),
   drop accounting audit, main-loop utilization delta.
5. **Wave I-3** (impl): Phase 3 capture node + preview-from-node + Phase 4
   raster UI.
6. **Wave R-3** (review/opt): capture parity audit (full-depth math vs the
   deleted in-session implementation), UI review, plan-drain check.

## Rig items (stage-f, accumulated at dispatch)

Recorder node records L/C/R at full rate with the graph row live (ingest ≈
camera rate, drops ≈ 0 on an idle machine); `.fovea` output byte-compatible
with the previous writer (bench-recorder pass); capture parity (same
resources, full bit depth) vs a pre-wave capture; raster capture: N-cell grid
→ N indexed resources with per-shot metadata snapshots; orchestrator main-loop
utilization flat while recording (the point of the wave).
