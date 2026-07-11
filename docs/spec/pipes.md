# Pipe broker & brick nodes — behavior spec

Behavioral contracts for the SHM pipe broker session and the session-owned native
brick nodes. Source pointers are per section; the code carries only load-bearing
invariants inline.

Common invariants across brick nodes:
- Seam-injected: brick nodes never import native core. `index.ts` wires the real
  `Aravis.attach*`/`detach*`/param setters; vitest drives fakes and never loads the addon.
- C-21 consumer gate: a chained brick runs only while someone reads its output pipe
  (refcount on `connectPipe`).
- C-20 slot sizing: variable-size outputs (slice/scale) over-provision the ring slot.

## Pipe broker session {#pipe-session}

Source: `app/orchestrator/pipe-session.ts` (WS1 / C-17 + compose protocol C-24 step 3)

Advertises typed SHM pipes, brokers the one-time `connectPipe`/`disconnectPipe`
handshake to the native `core.Pipe` publisher (refcount consumers), and
materializes/tears down composed nodes on renderer demand. Nothing per-frame passes
through here.

Compose is two-mode (ruled):
- `camera/`-rooted ids: refcount semantics — compose = ensure-materialized + ref
  (idempotent across windows; two windows composing the same fovea share one brick);
  decompose = unref; refs→0 = teardown via the brick's materializer (fovea:
  detach+drop; convert/undistort have no materializer — pre-advertised, refs are
  bookkeeping and the C-21 consumer gate parks them naturally).
- `win/<windowId>/`-rooted ids: window-owned, exclusive — the id must sit under the
  caller's authoritative windowId (`hub.windowIdOf(channel)`, A-34; a renderer cannot
  spoof it) and is torn down with the window.

Window close (`hub.onWindowClosed` — fires on DESTROY, not reload) auto-unrefs
everything that window composed and tears down its win/ nodes. The broker +
materializers + window hooks are injected.

## Undistort pipe {#undistort-pipe}

Source: `app/orchestrator/undistort-pipe.ts` (C-23; re-chained per
unified-time-and-topology §5)

Sessions advertise a first-class `camera/<serial>/undistort` SHM pipe alongside the
registry's `camera/<serial>/convert` one. Session-scoped (not registry-scoped) because
the producer needs the center calibration only the session loads
(`triple.undistort.calibration`). The native undistort brick chains on the shared
converter (source = the convert brick's pipeId — BGRA in, never raw Bayer; demand
propagates: the undistort running keeps the converter awake) and is gated by the pipe's
own connectPipe refcount (C-21).

Two variants (proposal §5 per camera):
- CENTER: classic intrinsic undistort (`{ cal }` — cached remap maps built natively
  from the plain persisted calibration JSON).
- L/R (mirror-steered fovea cams): `{ homography: true }` — per-frame `warpPerspective`
  with H looked up from the brick's native ParamRing by the frame's host-ns time; H
  samples pushed by a session-owned `homography-feeder`. An empty ring passes frames
  through untouched (metered as `passthrough`).

Encoding (ruled once): id `camera/<serial>/undistort` exactly parallel to `.../convert`;
pixel format lives in `spec.pixelFormat` (RGBA8 first), NOT in the id. A future second
format of the same stream is a separate pipe id with an `@<format>` suffix.

## Raw pipe acquisition {#raw-pipe}

Source: `app/orchestrator/raw-pipe.ts` (multi-fovea-recording ruling 5)

A single process-wide owner for the full-bit-depth `camera/<serial>/raw` (unpacked
16-bit container) and `camera/<serial>/raw12p` (packed verbatim wire) pipes:

- ONE advertise per pipe id EVER (kills the R-3 double-advertise class — a second
  advertise of a live id would clobber the segment out from under an already-connected
  consumer).
- Refcounted attach: the first acquirer advertises + attaches the native producer; later
  acquirers of the same id bump the count and share it.
- Refcounted release: the last release detaches the producer + unadvertises. Idle = the
  id is fully retired and can be re-advertised with fresh geometry on the next acquire.

Both payload kinds are distinct ids (`.../raw` vs `.../raw12p`), each owning its own
refcount + native attach/detach fn (kind-routed through the seam). Multiple sessions
share ONE registry so their independent capture-vs-recording policy guards still apply,
but a clobber is structurally impossible: two acquirers of a live id share the same
segment instead of racing two advertises.

## Scale pipe {#scale-pipe}

Source: `app/orchestrator/scale-pipe.ts` (split-disparity-nodes ruling 5)

A general-purpose session-owned native chained brick (`ScaleStream`) that resizes a
source pipe's frames and publishes them as its own C-20 variable-size pipe. The param is
reactive (`retune`, applied on the next frame, no re-attach) and is exactly one of:
`{ ratio }` (out = in × ratio), `{ dwidth }` (fixed width, height follows aspect),
`{ dheight }` (fixed height, width follows aspect), `{ dsize }` (exact w×h).

Output dims are recomputed per frame from the params + that frame's active input dims
(variable-size sources — e.g. a slice pipe — just work). The source frame's crop origin
is forwarded UNSCALED (source full-res coordinates): consumers un-scale their local
coords with the ratio they commanded, then add the origin. disparity-scope puts one in
front of each template-match input so the match kernel does no resizing.

## Slice pipe {#slice-pipe}

Source: `app/orchestrator/slice-pipe.ts` (split-disparity-nodes, ruled 2026-07-09)

A general-purpose session-owned SLICE node: a named reuse of the native fovea crop brick
— a live-steered ROI copy of a source pipe's frames, published as its own C-20
variable-size pipe (every frame carries its active dims + frame-bound crop origin in the
v4 slot header — the property downstream consumers use to lift local coordinates back to
the source frame). It is the session-owned sibling of `createFoveaMaterializer`
(pipe-session.ts): same advertise + attach + steer + retire mechanics, but named ids
(`nodeId.slice(serial, name)`) outside the renderer-composed numbered slot space — a
session's crops (disparity's match strip / display tile) never churn through the compose
protocol.

## Stereo disparity pipe {#stereo-pipe}

Source: `app/orchestrator/stereo-pipe.ts` (stereo-disparity-and-heatmap-nodes)

The first TWO-INPUT chained brick (`StereoStream`) — SGBM over a left/right pair of frame
pipes, publishing a single-channel CV_32F disparity map as its own C-20 pipe
(`pixelFormat: "Disparity32F"`, `dtype: "F32"`). Ticks on every LEFT arrival paired with
the LATEST RIGHT frame (latest-wins on both taps — no cross-camera seq comparison);
disparity is in left-frame coordinates and the left frame's timestamps/origin are
forwarded. Params are reactive (`retune`, next tick, no re-attach). On-demand (ruling 2,
the ChainedStream contract): the brick runs iff its pipe has consumers (or a downstream
tap subscribes); parked, its SGBM cost is exactly zero.

## Heatmap pipe {#heatmap-pipe}

Source: `app/orchestrator/heatmap-pipe.ts` (stereo-disparity-and-heatmap-nodes)

A native chained brick (`HeatmapStream`) that colormaps a 1-channel source pipe (CV_32F
or CV_8U — the stereo disparity map is the flagship input) to an RGBA8 pipe
(COLORMAP_TURBO). Normalization is reactive (`retune`): explicit `{min, max}` bounds, or
absent → per-frame min/max auto-normalize. Active dims + origin + timestamps forwarded
from the source (trusted-time). On-demand: while it runs its tap keeps the upstream
(stereo) brick awake — the renderer connecting/disconnecting this one pipe starts/stops
the whole SGBM chain.

## Composite pipe {#composite-pipe}

Source: `app/orchestrator/composite-pipe.ts` (composite-node-and-center-select-fix §B)

A two-input native brick (`CompositeStream`) — a per-pixel BGRA op (anaglyph / L-vs-R
difference) over a left/right pair of frame pipes, publishing an RGBA8 pipe. Ticks on
every LEFT arrival paired with the LATEST RIGHT frame (latest-wins); output is in
left-frame coordinates and the left frame's timestamps/origin are forwarded. The mode is
reactive (`retune`). On-demand: the brick runs iff its pipe has consumers — selecting the
center view IS the demand.

## Compress pipe {#compress-pipe}

Source: `app/orchestrator/compress-pipe.ts` (multi-fovea-recording rulings 9/10)

A core-free wrapper over `Aravis.attachCompressPipe`: the native thread FIFO-reads an
already-advertised source pipe (raw12p / raw / convert / …) and republishes each frame as
an INDEPENDENT zlib blob (per-frame, so the container stays seekable) into a sibling output
pipe advertised here. The output advert carries the source format with the `/zlib` suffix
baked into `pixelFormat` (ruling 9 — offline readers split on "/" and decompress
right-to-left), the same dims/significantBits as the source, and `maxBytes` sized to the
zlib worst case. The recorder consumes the output pipe with zero extra config
(advert-verbatim socket, ruling 8). Consumer-gated: the output pipe's 0→1 connect edge
spins the native runner up (connects the source); →0 parks it.

## Pair pipe {#pair-pipe}

Source: `app/orchestrator/pair-pipe.ts` (pairing-nodes P-1)

A core-free typed surface over `Aravis.createPairStream` — the per-stage L/R pairing brick
(two in-process FIFO taps joined against FIN-derived anchors on the brick's own thread;
record output via a batched async iterator, MultiKcf pattern). ALWAYS-RUNNING lifecycle
(ruling 5): a session creates its stage bricks with the trigger topology and releases them
with it — the brick is NOT consumer-gated and keeps consuming (+ dropping) with zero
subscribers. Trigger mode ONLY (ruling 1): anchors are real FIN outcomes; in free-run the
pool is empty and the brick idles.

## Anaglyph style setting {#anaglyph-style}

Source: `app/orchestrator/anaglyph-style.ts` (user ruling 2026-07-09)

The app-level anaglyph style setting, orchestrator side. Reads the configured
left-eye/right-eye color arrangement from the shared `["config"]` document — the same
store-hub read pattern `record-compression.ts` uses (NOT `@lib/config`, which pulls Vue
into this Vue-free process). Unlike the recording method (read once at recording start),
the style is LIVE: `subscribeAnaglyphStyle` rides the store-hub's in-process broadcast so a
Settings change retunes the composite brick without a reconnect. The style union +
validation live in `docs/schema/anaglyph.ts` (the single source of truth, Vue-free) —
imported directly here so it cannot drift.
