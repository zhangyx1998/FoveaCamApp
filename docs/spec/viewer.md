# Standalone viewer — behavior spec

Behavior contracts for the standalone recording viewer (`app/src/viewer/**`,
`app/electron/viewer-engine.ts`). Source files carry `// spec:` pointers to the
anchors below; this file is the narrative home moved out of those headers so the
code stays lean. Governing proposals: `docs/proposals/standalone-viewer-and-fcap.md`,
`docs/proposals/viewer-timeline.md`, `docs/proposals/viewer-export.md`,
`docs/proposals/fovea-footprint-overlay.md`; container format
`docs/history/refactor/recorder-container.md` §2b.

## Topology {#topology}

The viewer is orchestrator-free (ruling 1): the retired C-8 pinned "viewer
session" is gone, so playback keeps working while the orchestrator is down,
busy, or restarting — that is the point of the ruling.

Each viewer window owns ONE playback ENGINE, a MAIN-owned `utilityProcess` (one
per window, one open container per process). It cannot be a `worker_threads.Worker`
spawned from the window: Electron renderer processes cannot construct Node
workers ("The V8 platform … does not support creating Workers"), so main forks it
exactly like the orchestrator/janitor. The engine hosts the whole data layer out
of the window process: MCAP reading (`source.ts`), frame decode (`decode.ts`),
and timestamp-paced playback (`player.ts`).

Port handshake: main creates a `MessageChannelMain`, forks the engine, posts
`{ type: "init", file }` over `process.parentPort` with `port1` transferred, and
delivers `port2` to the window via `webContents.postMessage("viewer:port")` →
preload relay → DOM `MessagePort`. Renderer and engine then talk DIRECTLY over
that one port. Cross-process `postMessage` is structured-clone COPY — a transfer
list carries ports only, never ArrayBuffers, so frame buffers are COPIED to the
renderer (fine for playback; zero-copy was only ever same-process). Main hands
the FILE to the engine in `init`, so there is no `open` command — the engine
opens eagerly.

One window = one file = one engine. There is no `fileId` keying; the
one-window-per-file dedupe lives in the main-process window manager, which keys
one engine per window (`viewer-engine.ts` lifecycle: single-writer sidecar,
terminate-before-respawn on dev reload, flush-before-close with bounded grace).

## Wire protocol {#protocol}

`protocol.ts` — renderer-local message shapes between window (main world) and
engine; renderer-safe, Node-free (types + string constants). Replaces the retired
`@lib/orchestrator/viewer-contract`; free to evolve with the code.

- `ViewerFileInfo` / `ViewerChannelInfo`: static half of an open container. Times
  are ns RELATIVE to the first message (0..durationNs) — plain numbers, not
  bigints (2^53 ns ≈ 104 days). `startEpochMs` is absolute wall-clock epoch in
  MILLISECONDS (absolute epoch ns ~1.75e18 exceeds 2^53). `truncated` = opened via
  the streaming re-index fallback (no MCAP footer). Capability flags gate UI:
  `ffmpegAvailable`, `wideCalibrationAvailable`, `wideCameraDeclared`, `baselineMm`.
- Renderer → engine `ViewerCommand`: `play`/`pause`/`seek`, `set-enabled` (decode
  gate — see [enabled set](#enabled-set)), `save-ui`, `get-stats`, the
  `export-*` family, `close`.
- Engine → renderer `ViewerEvent`: `opened`, `open-error`, `position`,
  `telemetry`, `descriptor`, `stats`, `export-update`, `frame`, `error`.
- `ViewerFrameEvent.buffer` is a fresh cross-process COPY; reconstruct as
  `Object.assign(new Uint8Array(buffer, byteOffset, length), {shape, channels})`.

## Read layer {#source}

`source.ts` — `.fcap`/`.fovea` reads on the engine thread. All file I/O is async
`fs.FileHandle` reads in bounded chunks; nothing blocks the event loop for long
(playback pacing shares the thread). Two implementations behind one interface:

- **Indexed** (normal): `McapIndexedReader` — seeks + time-range queries served by
  the chunk index, no full-file scan.
- **Streaming fallback** (footerless/crash-truncated — B-4 finding: readers MUST
  carry this): a sequential `McapStreamReader` scan recovers every complete
  flushed record. The initial scan collects channels + time bounds; each
  `messages()`/`latestBefore()` rescans (O(file), acceptable for the recovery
  edge). Sources opened this way report `truncated: true`.

## Decode {#decode}

`decode.ts` — `x-fovea-raw` → displayable Mat, driven entirely by §2b channel
metadata (dtype/shape/channels/pixelFormat/significantBits), never by sniffing
bytes. Mirrors the live paths: 16-bit scaled to 8-bit by significant bit depth
(12p data lives 0..4095 in a 16-bit container — `significantBits` + the 12-bit
readout project), Bayer mosaics demosaiced to RGB via core Vision `cvtColor`,
result a 1/3/4-channel Uint8Array Mat matching `FrameView`'s ImageData path.

core Vision is imported LAZILY and only when a channel needs it (U16 scaling /
Bayer) — pure-U8 channels (Mono8/BGRA8 previews) decode with zero native
involvement; hence the async factory, synchronous per-frame decoder. Runs on the
engine — the scoped exception to no-core-in-renderer (offline file utility,
decoupled from the orchestrator, decode off the UI thread).

## Playback engine {#player}

`player.ts` — per-file playback with timestamp pacing. Each message is due at
`(logTime - anchor) / rate` wall-clock after playback started, slept-to via an
injectable clock (tests inject a virtual clock; pacing asserted deterministically
over real file I/O). Frames later than `LATE_SKIP_MS` behind schedule are skipped
and accounted `drop("late")` — pacing degrades by dropping, never by stretching
time. Everything is generation-guarded: pause/seek/play/close bump the generation;
a stale in-flight loop iteration stops without touching state (the V5/V10/V13
stale-async-completion class).

The player is transport-agnostic — it takes `publishFrame`/`emitTelemetry`/
`emitPosition` hooks + a `PlayerMeter` (no-op default; structurally a subset of
the orchestrator's retired `WorkloadHandle`), so it is unit-tested in isolation.

Paused-scrub coalescing is LATEST-WINS: a scrub-drag fires one seek per
pointermove; `pendingSeekNs` holds the newest target, a single refresh loop
consumes the latest and drops the rest, and `republishAt` aborts as soon as a
newer target lands — the decode node follows the latest seek, never trails the
backlog. On a paused scrub each frame channel republishes its latest-before frame;
telemetry (one multiplexed channel) recovers only the single most-recent doc;
descriptor tracks refresh independently.

## Timeline model {#timeline}

`timeline.ts` — PURE multi-track geometry (Vue/Node/core-free, unit-tested).

- **Blocks**: a `ChannelBlock` is one frame channel's span `[startNs,lastNs]` in
  file-relative log time. Telemetry/descriptor (json) channels are NOT blocks —
  they bind to frame streams as overlays.
- **Master detection** (ruling 1): the wide/center channel. `fovea:wide-camera` is
  a container-level metadata record (intrinsics only, no channel pointer), so the
  master CHANNEL is chosen by recorder naming: manual-control names its wide stream
  `center`; multi-fovea names it `wide`. `wideCameraDeclared` only drives the "no
  wide designation" hint.
- **Initial layout** (ruling 2): greedy min-track interval scheduling — master on
  row 0, the rest first-fit onto the fewest non-overlapping rows. Per ruling 10 this
  runs ONLY at sidecar init (first open/reset); thereafter the sidecar `tracks`
  layout is authoritative and `moveBlock` mutates it directly — auto-pack is NEVER
  re-applied over user placement. `reconcileLayout`/`layoutMismatch` handle a stored
  layout vs the container's actual channels WITHOUT silently discarding it.
  `insertBlockAt(rows, blocks, channel, insertBefore)` supports the touch-up
  ruling 8 gesture — dropping a block on the thin boundary BETWEEN two lanes
  removes it from its row and splices it in as a brand-new track (empty rows drop,
  per-row start-time sort; a fresh row never collides). The on-lane drop still
  routes through `moveBlock`/`dropCollides`.
- **Initial playhead** (touch-up ruling 1): on open the playhead defaults to
  `firstMeaningfulNs(blocks)` — the earliest block start — instead of t=0, so at
  least one tile shows immediately. A persisted `playheadNs > 0` still wins; the
  change is only the fresh/absent default.
- **3D pairing** (ruling 4): L/R of one stream by side-tagged naming. A base pairs
  only when exactly one left and one right claim it (ambiguous never false-pairs).
  Side tokens match a WHOLE segment; single-letter `l`/`r` pair only as a standalone
  segment leaving a non-empty shared base.
- **Tile order** (ruling 9): Z order = master row first, then top→bottom; a
  non-`disabled` 3D pair collapses to ONE tile at its higher (earlier) row.
- **Tile slots** (touch-up ruling 2): `composeTileSlots` yields ONE slot per
  track — either a real `tile` or a `placeholder` (`no-frame` / `disabled` /
  `pair-collapsed`), so slot i ↔ track i is stable. A non-disabled pair renders in
  the FIRST of its two tracks; the partner track's slot becomes a `pair-collapsed`
  placeholder naming the base. The UI renders the slots through a persisted
  `tileOrder` (a permutation of track indices, `reconcileTileOrder` against the
  live track count) that the user pointer-drags to rearrange; placeholders are
  drop targets only. `trackRole`/`trackColor` give each track a theme hue (L/C/R
  role colors via `sideOf`/wide names, else a deterministic muted cycle) applied
  as a lane + block tint, the tile-slot header chip, AND — tiles-split-and-project
  ruling 2 — a borderless-at-rest tile outline that raises to the track hue on
  highlight/focus plus the projected pane's `theme` (below).
- **Tile split layout** (tiles-split-and-project ruling 3): the tiles row is a
  `display:flex` strip that ALWAYS fills 100% of the panel and NEVER scrolls. Tile
  widths are FRACTIONS (persisted `tileSizes`, `reconcileFractions` against the
  slot count → equal by default), rendered as `flex:<fraction> 1 0` so the tiles
  share the row proportionally regardless of divider/padding px. A thin divider
  handle between adjacent tiles pointer-drags to resize that pair via
  `resizeAtDivider(sizes, i, deltaPx/rowWidthPx)` (sum preserved, each side floored
  at `MIN_TILE_FRACTION`), live during the drag and persisted on release. The old
  px `tileWidth` slider + horizontal scroll are retired.
- **Projectable tiles** (tiles-split-and-project ruling 4): each REAL tile's
  `FrameView` carries a `:projection` descriptor `{ source:{kind:"viewer",
  recording:<basename>, tileKey}, title, theme }` so its project-to-window button /
  drag opens a projection that MIRRORS the tile. `tileKeyOf(tile)` (== `tileKey`:
  single→channel, pair→`pair:<base>`) is the stable broadcast/descriptor key. A
  window-lifetime `createViewerFramePublisher(basename, …)` re-broadcasts the tile's
  CURRENT displayed Mat (post pair-collapse / 3D resolve) on each `frameTick`, but
  only for keys a projection has actively subscribed to (`wanted`) — ref-counted, so
  the hot path is free with no projection open. Placeholders aren't projectable.
- **Decode set** (ruling 3): the frame channels the engine must decode — every
  enabled channel minus the hidden side of any left-/right-only pair; sorted +
  de-duplicated for a stable wire payload.

## Time viewport {#viewport}

`time-viewport.ts` — PURE visible-time-window algebra (Vue/Node-free,
unit-tested), the touch-up rulings 3/5/6 geometry. A `TimeViewport {t0,t1}` is the
visible file-relative window; every pointer x ⟷ time mapping in the tracks area
(block x/width, playhead %, ruler ticks, click/drag-seek, wheel) goes through
`fracOf`/`nsAtX` against it instead of a duration-percent. Not persisted (this
wave): it resets to `fullViewport(duration)` when a file loads.

- **Zoom/pan** (ruling 5): ctrl+wheel (= macOS pinch) → `zoomAt(factor, anchorFrac)`
  keeping the cursor time fixed (span clamped to `[MIN_SPAN_NS, duration+2·bleed]`);
  plain horizontal wheel → `panSoft(deltaNs)` with rubber-band softening past
  `[−bleed, duration+bleed]`; vertical wheel falls through to native track-list
  scroll. On gesture idle (~150 ms) an out-of-bounds viewport SNAPS back to
  `settleTarget` INSTANTLY (tiles-split-and-project ruling 1 — the rubber-band
  RESISTANCE during the drag stays in `panSoft`; only the settle is immediate, no
  rAF ease). `bleedNs`/`BLEED_FRACTION` size the rubber-band allowance; the UI
  draws the out-of-`[0,duration]` regions as dimmed hatched **bleed strips**.
- **Ruler** (ruling 3): `rulerTicks(vp, widthPx)` yields nice-number ticks
  (1/2/5·10^k ns ladder, s/ms boundaries) targeting ~a fixed px spacing, major
  ticks labeled (mm:ss.SSS adapting to the step). Rendered as an absolute overlay
  strip at the tracks top (above lanes, below the playhead); click/drag seeks via
  `nsAtX` clamped to `[0,duration]`.
- **Smooth playhead** (ruling 6): `interpolatePlayhead(lastNs, lastAtMs, nowMs,
  rate, playing, duration)` extrapolates the last worker position by wall-clock ·
  rate while playing (clamped to duration; identity when paused/scrubbing). A rAF
  loop drives ONLY the visual playhead line + its %; worker `position` events
  re-anchor it and pause/seek snap. Tiles/overlays keep deriving off the RAW worker
  position (no per-frame re-derivation), and the transport timecode shows the raw
  position (no fake precision).

## Enabled-set decode gate {#enabled-set}

Ruling 3: `set-enabled` restricts which FRAME channels decode. A channel absent
from the set is ingested + dropped without decode (`drop("disabled")`), applied
BEFORE the expensive decode. `null` = decode all frame channels. json
(telemetry/descriptor) channels are never gated — cheap, and feed overlays
regardless. A newly-enabled channel gets a paused seek-refresh at the current
playhead so it repaints immediately; during playback its frames stream in
normally.

## Footprint overlay {#footprints}

`footprints.ts` — PURE fovea-footprint model (unit-tested). A footprint is a
recorded fovea stream's frame rectangle projected onto the WIDE (master) tile: the
four corners mapped through the frame's recorded per-frame `affine` (the 3×3
row-major homography telemetry carries — `A2H(angle)` at that frame's exposure),
landing in the same undistorted wide pixel space as the tracker bbox.

- **Pairing (color grouping)**: L/R of a fovea PAIR share one color; pairs derive
  from channel naming (side token stripped, remaining BASE is the key). Multi-fovea
  names its two fovea streams exactly `left`/`right` (EMPTY base — the sole stereo
  pair), so unlike the timeline's `detectPairs` an empty base still pairs here.
- **Coloring**: greedy interval-coloring over each group's block range — overlapping
  groups get distinct color indices, disjoint groups may reuse; component maps the
  index into `TARGET_COLORS` (mod length).
- **Depth**: vergence-plane distance for a pair from the two eyes' recorded angles
  + baseline.

## Stats popover {#stats}

`stats.ts` — PURE static-stats assembly + formatting for the right-click stats
popover (unit-tested). Assembles a channel's STATIC container stats from the open
`ViewerChannelInfo` (metadata + block span + per-channel message count shipped in
`opened`) plus number/time formatting and popover clamp math. LIVE stats (decode
rate / frames decoded / last-shown timestamp) are the engine's, returned over
`get-stats`→`stats` as `StreamLiveStats`; this module only formats them.

## UI-state sidecar {#sidecar}

`sidecar.ts` — PURE UI-state persistence (node-free; types + JSON + validation,
unit-tested). Ruling 8: ALL viewer UI state persists to `<recording>.fcap.ui.json`
NEXT TO the container — the `.fcap` is opened READ-ONLY (fs flag "r"); the sidecar
is the only file the viewer writes. The worker owns the debounced read/write.

Robustness (ruling 10): ABSENT → silently initialize. PRESENT-but-corrupt or
channel-MISMATCHED → the caller CONFIRMS with the user before reinitializing (never
silently discard a layout). `classifySidecar` distinguishes absent/ok/corrupt at
the file level; channel-mismatch is decided in the UI (it needs the container's
channels). Unknown keys dropped; every field type-checked + clamped so a
hand-edited/version-skewed file can't wedge the UI. `SIDECAR_VERSION` bump ⇒ older
`v` treated as corrupt (→ defaults) until a migration is added. The touch-up
added an OPTIONAL `tileOrder?: number[]` (ruling 2 — the persisted tile-slot
permutation): absent in older files (no version bump), conservatively cleaned
(finite non-negative integers, de-duplicated) and only surfaced when present, so
an older sidecar still round-trips byte-identically. Tiles-split-and-project
ruling 3 adds an OPTIONAL `tileSizes?: number[]` (the persisted tile-width
fraction list, defensively parsed) and RETIRES the px `tileWidth` from the
written shape — old sidecars carrying `tileWidth` still parse without error (the
field is ignored).

## Video export {#export}

`export/**` + main-side dialog/close-intercept in `main.ts`. Proposal
`viewer-export.md`. Main owns the system save dialog (spec 8) and the
window-close abort intercept (spec 11); the ffmpeg pipeline lives in the engine.

- **queue.ts** — PURE queue state machine (spec 10/11): owns job records + the
  serial/parallel dispatch policy, RETURNS the ids that should now start; the runner
  performs the ffmpeg spawn/abort. Parallel OFF (default) ⇒ at most ONE running job,
  the rest queue. Parallel ON ⇒ every queued job dispatches immediately. Flipping ON
  dispatches the backlog; flipping OFF never pauses a running job.
- **runner.ts** — the impure edge (child_process, fs), hosted by the engine (the
  one process with random `.fcap` access + core decoders): decode → normalize to raw
  `rgba` → pipe into ffmpeg (optionally through a remap filter for undistort) →
  parse progress from fed frames → SIGKILL + unlink on abort.
- **undistort.ts** — PURE TS remap-map generation (spec 4; viewer has no core). From
  the recording's embedded camera matrix + distortion (`fovea:wide-camera` singleton
  — only the WIDE/center stream carries it; fovea streams get disabled-with-hint).
  Standard OpenCV `initUndistortRectifyMap` (identity rectification): per DEST pixel,
  Brown-Conrady FORWARD model finds the SOURCE pixel; ffmpeg `remap` samples through
  two 16-bit PGM maps; OOB samples filled (alpha 0 with transparency, else black).
- **normalize.ts** — PURE decoded-Mat → raw `rgba` for the export pipe; mirrors
  `FrameView.vue`'s `expandToRGBA` exactly (1ch → gray replicated, 3ch → RGB + opaque
  alpha, 4ch → passthrough; decode yields RGBA-ordered bytes).
- Supporting pure modules: `ffmpeg-args.ts`, `codecs.ts`, `fps.ts`, `banner.ts`,
  `ffmpeg-detect.ts`, `types.ts`.
