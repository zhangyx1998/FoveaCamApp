# Plan: Recorder Container Format + Viewer + Python Sub-Project (Stage 5, item 4)

> **Status:** Format DECIDED (MCAP, §2) and **writer LANDED (B-5,
> §2b — schema contract pinned there)**. Round 3 dispatched: viewer
> data-layer (C-8: `viewer` session replaying .fovea through the
> existing shm frame transport), viewer window/UI + file association
> (A-11), Python sub-project (B-6). Pending user: full-res tier
> (sharding), `.fovea` extension veto, PyPI publish.
> **Owner:** Yuxuan (direction; PyPI publish is user-gated like commits)
> / planner (spec) / coder threads (impl).
> **Related:** [`multi-window.md`](./multi-window.md) (viewer window
> class), [`workload-metering.md`](./workload-metering.md) (recorder is
> a flagship metered workload), [`orchestrator.md`](./orchestrator.md)
> (S3 recorder worker; Stage 4 shm — frames already live in slots).

## 1. Requirements (user, 2026-07-06)

1. **Container format** replacing today's per-stream binary blob + JSON
   sidecar (`.stream`/`.meta`/manifest from `stream-writer.ts`): each
   dump is a **single file**, better efficiency.
2. **Realtime at full load**: 3 cameras × 60 fps raw, plus potentially
   extra processed-frame streams, written without impacting foreground
   threads.
3. **File association**: OS-level extension → opens in a dedicated
   FoveaCamApp **viewer window** (non-exclusive, one window per file).
4. **Python interface** for downstream ML training/inference.
5. **(2026-07-06 addendum)** The current drop-in Python script template
   (`stream-decoder.py`, copied into each recording folder) becomes a
   **top-level sub-project published to PyPI** — proper package,
   `pyproject.toml`, CLI entry points, tests. It must read the new
   container natively AND keep a legacy `.stream`/`.meta` read path
   (existing dumps + external tooling stay loadable); this retires the
   per-folder template mechanism (writer may still embed a tiny README
   pointing at the package).

### Shortcut (user, 2026-07-06)

**Ctrl/Cmd-R triggers the recorder** (the default reload binding is
removed app-wide; dev reload moves to Ctrl/Cmd-Shift-R — see
multi-window.md req. 6). Exact semantics (start/stop toggle? which
window classes respond?) to firm up in spec.

## 2. Format evaluation — ✅ DECIDED (B-4, 2026-07-06): MCAP, conditional GO

Bench: `playground/bench-recorder/` (committed, re-runnable; full table
+ methodology in its RESULTS.md). Headline (M1 Max, 32 s sustained,
3×60 fps raw 12p + 1×30 fps processed, single-file multiplexed writer
in one worker):
- **1.5 MiB/frame tier: 0 % drop, ~275 MB/s, ~0.6 core — clean GO.**
  (Matches the current camera format.)
- **6.2 MiB/frame tier: 41–71 % drop** — bottleneck is MCAP's
  **single serialized writer chain** (`McapWriter` is non-reentrant),
  NOT CPU (~1.2 cores max) or disk (~1.48 GB/s available).
  **Compression makes it worse** (the `compressChunk` hook is
  synchronous, on the writer chain).
- Crash recovery: indexed reader refuses footerless (crash-truncated)
  files; the sequential streaming reader recovers everything flushed —
  loss window ≤ 1 message with chunk size ≈ 1 raw frame. **Viewer and
  Python reader must therefore both carry the streaming/re-index
  fallback path.**

**Decision:** MCAP is the container. Follow-ups this creates:
1. **Full-res tier needs writer sharding** — split raw channels across
   multiple writer workers/files (or one file finalized by merge) IF
   6.2 MiB recording is a requirement → **user decision pending:** is
   full-res raw recording needed at launch, or is the current
   1.5 MiB-tier format sufficient initially (sharding becomes a later
   optimization)?
2. If compression is ever wanted: compress OFF the writer chain
   (separate workers, pre-compressed chunks), never in `compressChunk`.
3. Chunk size ≈ 1 raw frame as the crash-loss-window default.

### (superseded evaluation plan follows for reference)

**Primary candidate: MCAP** — multi-channel timestamped container built
for robotics logging: append-only realtime writes, per-channel schemas
(one channel per camera stream + processed streams + telemetry like
volt/tracker state that today gets sidecar'd or lost), optional chunk
compression (lz4/zstd), end-of-file chunk index (cheap viewer seeking;
crash-recoverable by re-index), first-class Python reader (answers the
ML requirement nearly for free), C++/TS writers available.
**Evaluate:** sustained write throughput at 3×60 fps raw frame sizes
(~1.5–6.2 MB/frame depending on format — measure both), memory
behavior of the TS or C++ writer in the recorder worker, crash
recovery, 12-bit packed payload handling (record raw sensor format —
ties to the 12-bit project).
**Plan B:** custom chunked container with index footer (only if MCAP
fails the throughput/footprint test — write the numbers down either
way).

## 2b. Writer LANDED (B-5, 2026-07-06, planner-accepted) + the schema contract

`app/orchestrator/recorder/`: one worker per container file, one
`McapWriter`, all ops on one promise chain; chunk ≈ 1 raw frame
(256 KiB chunkBytes); bounded per-channel queue (8) refusing before
copy, drops accounted; metered as `recorder:<file>`; `RecorderTopology`
seam keeps sharding additive (NOT implemented — user decision pending);
default backend `"fovea"`, legacy `.stream` writer preserved verbatim
in `recorder/legacy.ts` behind `RECORDER_BACKEND` (byte-parity tested);
worker is an eval'd CJS string (survives single-file orchestrator
packaging), `@mcap/core` path resolved by parent via createRequire.

**Schema contract (pinned for viewer + Python — do not drift):**
- One channel per recorded stream; `topic` = stream name;
  `messageEncoding: "x-fovea-raw"` — message bytes are the raw frame
  exactly as captured (12-bit-packed formats STAY packed).
- Channel metadata carries static decode props: `dtype`, `shape`,
  `pixelFormat`, `significantBits`, `channels`.
- One `telemetry` channel (JSON): per-frame extras (volt/angle/
  homography — the old sidecar payload).
- Timestamps: ns, monotonic from process start, shared across all
  channels of a session (absolute wall-clock anchor in file metadata).
- Extension `.fovea` (content = standard MCAP; generic mcap tooling
  reads it; per-dump README says so).
- Readers MUST handle footerless (crash-truncated) files via the
  streaming/re-index path (B-4 finding).

## 3. Realtime write path (planner notes)

- Recorder already runs in its own worker (S3) and frames already live
  in shm slots (Stage 4): the pipeline is slot → bounded handoff →
  worker copies/compresses/writes. The orchestrator loop must never
  block on the recorder — **bounded queue with explicit drop
  accounting** (drops are data, not silent).
- Compression: measured decision — zstd-fast/lz4 on the worker vs none;
  raw Bayer compressibility TBD; "none" is the safe default knob.
- Instrument from day one with the workload-metering schema (ingest
  per stream, busy %, write throughput, queue depth, drops).

## 4. Viewer + file association — ✅ LANDED (A-11 + C-8, 2026-07-06, planner-accepted)

Viewer window class (0..N, per-file dedupe, manifest-restorable) + File
menu Open…/Cmd-O + macOS `open-file` + second-instance argv + NEW
`app/electron-builder.yml` with `.fovea` fileAssociations (**appId is a
placeholder; association verified only at packaging — wall item**).
Data layer: `viewer` session replays files through the standard shm
frame transport (`fr:viewer:<fileId>:<channel>`); indexed reads with
footerless streaming fallback (`truncated` badge); timestamp pacing ÷
rate with late-drop; per-file workload meter. Contract:
`lib/orchestrator/viewer-contract.ts` (single shared pin, ratified).
E2E behavior = user GUI smoke (wall item).

### (original spec follows)

- electron-builder `fileAssociations` + macOS `open-file` /
  second-instance events in main → spawn a **viewer window** per file
  (multi-window.md taxonomy: non-exclusive, doesn't count for the
  welcome rule).
- Viewer: per-stream tracks, timeline scrubbing via the container
  index, frame display through the existing render components where
  possible. Decode path: main/worker reads chunks, hands frames to the
  window (mechanism TBD — could reuse the shm reader with a playback
  ring, or simple async reads; decide in spec).

## 5. Python sub-project — ✅ LANDED (B-6, 2026-07-06, planner-accepted)

`pyfovea/`: typed `.fovea` reader (§2b contract; telemetry joined by
stream+seq), GenICam 12p unpack + significant-bits scaling (numpy,
cv2 optional behind `[cv]`), full legacy `.stream`/`.meta` port
(tolerant of torn JSONL), `convert`/`inspect`/`export` CLI, fixtures
generated by the real B-5 harness (incl. a crash fixture recovering
3/6 frames). Standing gate: `pyfovea/.venv/bin/python -m pytest
pyfovea/tests` (28 tests; venv Python 3.14.6; mcap==1.4.0,
numpy==2.5.1, pytest==9.1.1). **Library pitfall recorded:** python
mcap `iter_messages` defaults to `log_time_order=True` which sorts →
consumes the whole stream → truncation errors fire before ANY yield;
crash recovery MUST iterate unordered. No publish automation (user
steering) — PyPI deferred pending manual verification on real
recordings. `stream-decoder.py` is superseded (retire the per-folder
template after the user verifies).

### (original spec follows)

- Top-level dir (e.g. `pyfovea/` — name TBD with user before PyPI),
  `pyproject.toml`, typed reader API + CLI (`inspect`, `export`,
  `convert` for legacy dumps), tests with small fixture files.
- Supersedes `stream-decoder.py` (absorb its logic: significant-bits
  scaling, demosaic helpers).
- New standing gate once it exists: its test suite (runner TBD —
  `/opt/homebrew/bin/python3` or a venv; decide at first dispatch).
- **PyPI publishing is DEFERRED (user steering, 2026-07-06):** no
  publish automation, no release CI/workflows — packaging metadata
  only. Publishing happens later, after the user's manual verification
  of the package against real recordings; the user pushes the button.

## 6. Sequencing

After (or overlapping the tail of) multi-window (viewer windows need
the window framework) and metering (recorder ships metered). The
**format evaluation (§2) starts early** — it's the critical path and
informs the writer, viewer, and Python reader alike. Split sketch:
format eval + writer = B or C (native/perf-adjacent); viewer window =
A; Python sub-project = any role, isolated surface.

> **Tier decision (user, 2026-07-07):** current 1.5 MiB tier suffices —
> sharding (B-P12) shelved until full-res raw recording is required.
