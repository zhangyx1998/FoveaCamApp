# Multi-fovea recording — raw 12p sensor streams + descriptor streams

Status: **SHIPPED (code-complete; rig pass owed)** — 2026-07-09, through the
R-2 close. Ruled r2.1 (user 2026-07-09, superseding the r1 tile-recording
model the same day; r2.1 added rulings 8–10: advert-verbatim format metadata
+ `/codec` compression suffix + ring v5). Successor to
[capture-recorder-nodes](./capture-recorder-nodes.md) — reuses its recorder
thread node; r1's per-frame-dims pixel schema is DROPPED. Live-rig
verification accumulates in `docs/hardware/stage-f.md` §"Multi-fovea
recording". See **AS SHIPPED** at the end for the commit chain, deltas from
the ruled design, and residuals.

## The recording model (user ruling, verbatim intent)

A multi-fovea recording contains ONLY:

1. **Raw Bayer 12p-encoded sensor frames** — the wire payload, verbatim and
   packed, for each camera (left fovea / center wide / right fovea). NOT the
   unpacked 16-bit container, NOT BGRA tiles. Each frame binds its
   **dynamic parameters**: mirror location (voltages; live-snapshot now,
   FIN-averaged when v2 firmware lands — same `volt.source` provenance as
   capture-recorder ruling) and the dynamic undistortion/homography mapping
   for the fovea cameras (mirror-dependent, changes per frame).
2. **A global singleton camera matrix for the wide stream** — one metadata
   record (intrinsics + distortion) applying to every wide frame; the wide
   camera is static so nothing per-frame.
3. **Multi-fovea target streams as DESCRIPTORS, not pixels**: per target, a
   stream of `{timestamp, bbox on the wide frame, frame pointers}` where the
   pointers name the left/center/right raw frames (per-stream seq) that
   observation corresponds to. Fovea imagery is RECONSTRUCTED offline from
   the raw streams + per-frame dynamic params; it is never re-encoded.

Rationale: the raw streams already contain every pixel the rig saw — the
fovea cameras ARE the per-target imagery (the scheduler round-robins the
mirror across targets, so each L/R frame belongs to one target). Recording
composed tiles would duplicate pixels lossily; descriptors + params make the
container the complete, minimal, offline-reconstructable record.

## Rulings

1. **Packed 12p tap (core)**: `frame->raw` is the UNPACKED container (12p→16
   at Frame construction) — unusable here. New pre-Frame ArvBuffer tap in
   `core/lib/Aravis/RawPipe.cpp` (or sibling) publishing the verbatim wire
   payload to `camera/<serial>/raw12p` pipes: fixed dims, pixelFormat = the
   wire format (Bayer 12p when the sensor runs 12p readout), stride/packing
   documented in the pipe advert. Extract-before-release discipline applies
   at the ArvBuffer level (copy into the ring inside the stream callback).
2. **Dynamic streams** (kept from r1): recorder node `addStream`/
   `removeStream` mid-recording; MCAP channels register mid-file; removal =
   drain-the-tail (R-1 semantics); pipe-CLOSED is a normal stream end.
3. **Descriptor channels**: recorder gains data (non-frame) channels —
   `addDataStream(name)` + `postData(name, message)` from the session, one
   channel per live target (`fovea/<target-id>`), JSON-encoded
   `{tNs, bbox:{x,y,width,height}, frames:{left,center,right}}` with seq
   pointers. Channels churn with targets (ruling 2 machinery).
4. **Per-frame dynamic params** ride the existing extras path (telemetry
   channel, correlated by stream+seq — exact binding, never blocks writes):
   fovea streams answer `onFrame` with `{volts, H}`; the wide stream posts
   no per-frame extras (`extrasStreams` gating) — its camera matrix is the
   §2 global metadata record written once at start.
5. **Recorder stays a pure pipe consumer**; raw12p pipes are acquired via a
   refcount-shared `raw-pipe` helper (one advertise per id ever — kills the
   R-3 double-advertise class; manual-control recording/capture migrate onto
   it. Whether manual-control ALSO moves to packed 12p payloads is a
   follow-on ruling — the helper supports both payload kinds meanwhile).
6. **Viewer**: minimal playback support — unpack 12p→16 + debayer for
   display, descriptor channels surfaced as overlay data (bbox on wide).
   Channels appearing mid-file + per-stream ranges shorter than the
   container must work. Deep analysis tooling stays offline/Python (MCAP
   schema is the contract).
7. **UI**: record button in the multi-fovea drawer, Cmd-R via
   `onRecorderTrigger`, `recording:finished` → auto-open viewer.
8. **Pixel format lives in per-stream metadata, sourced from the pipe
   advert VERBATIM** (user r2.1, 2026-07-09): the recorder input is a named
   SOCKET — the orchestrator connects a raw camera node output, a convert
   node output, or a compression node output to it with NO extra config.
   The recorder copies the advert's format fields (pixelFormat, dims,
   stride, significantBits) into the MCAP channel metadata and treats the
   payload as opaque bytes. It must never parse, assume, or unpack.
9. **Intra-frame compression, spec'ed per raw stream, baked into the
   pixelFormat string with a slash** — e.g. `BayerRG12p/bz2` — attached to
   the metadata of the compression node's OUTPUT pipe. A compression brick
   (native thread, per-frame independent compression so the container stays
   seekable) consumes any frame pipe and advertises the same dims with the
   `/codec` suffix appended. Offline readers split on `/`: decompress the
   suffix chain right-to-left, then interpret the base format. Codec set
   starts with what the system provides without new deps (zlib; bz2
   available likewise — suffix makes codecs pluggable); throughput per
   codec is measured, drop-accounted, and rig-verified — compression is
   OPTIONAL per stream precisely because lossless codecs may not hold
   full-rate 12p on all three cameras.
10. **Ring layout v5**: compressed payloads vary per frame, so `SlotHeader`
   gains `payloadBytes` (0 = derive from dims, the uncompressed/live path —
   field appended, offsets unchanged, LAYOUT_VERSION 5; single-process
   writer+reader rebuild together, no skew). `readSeqInto` surfaces the
   actual payload length; consumers trust the returned view length, never
   dim-derived math.
11. **Interleaved execution**: I-1a (recorder: dynamic streams + data
   channels + advert-verbatim schema + global metadata) ∥ I-1b (core:
   ArvBuffer tap → raw12p pipes) → I-1c (core: ring v5 payloadBytes +
   compression brick — AFTER I-1b, serialized core builds) → R-1
   (review/opt) → I-2 (session wiring: descriptors from the
   runtime/scheduler, params extras, refcounted raw pipes, UI, viewer
   playback incl. `/codec` decode) → R-2 (review/opt + churn soak
   end-to-end + docs/stage-f close).

## Gates

vue-tsc 0 / vitest / soaks / vite build at wave closes; core: `cd core &&
make` + hardware-free `core/test/NN-*.ts` set from repo ROOT. No Electron.
Rig items accumulate in `docs/hardware/stage-f.md` §"Multi-fovea recording"
(12p payload verbatim vs a reference wire capture, descriptor↔frame pairing
under live round-robin, offline reconstruction fidelity).

## AS SHIPPED (2026-07-09, R-2 close)

### Commit chain (one line per wave)

- **I-1a** `b3e3aaf` — recorder node: dynamic `addStream`/`removeStream` +
  `addDataStream`/`postData` data channels + advert-verbatim schema
  (`FRAME_METADATA_KEYS` copied from the pipe, never re-derived) + the
  `fovea:wide-camera` global metadata record.
- **I-1b** `9be0c07` — core: pre-Frame ArvBuffer tap → `camera/<serial>/raw12p`
  pipes (verbatim packed wire payload; extract-before-release at the buffer).
- **I-1c** `b8c86fc` — core: ring layout v5 (`SlotHeader.payloadBytes`,
  `readSeqInto` surfaces actual length) + the per-frame zlib compression brick.
- **P-1** `426eb05` — pairing-nodes: PairStream brick + anchor enrichment node
  + controller migration (see `pairing-nodes.md` AS SHIPPED).
- **R-1** `ac6ee85` — review/opt over I-1a/b/c + P-1; resolved-anchor key
  delivery for the downstream exact stage.
- **I-2a** `6e14b6e` — refcounted `raw-pipe` registry (one advertise per id
  ever, `raw`/`raw12p` distinct kinds; manual-control capture+recording
  migrated) + viewer codec/12p decode (`splitCodecs`/`decompressChain`/
  `unpack12p` + significantBits down-scale + Bayer demosaic).
- **I-2b** `c015a01` — the multi-fovea recording controller (raw12p L/C/R,
  optional `/zlib` sibling routing, `fovea/<slot>` descriptor channels, extras
  from matched anchors, wide-camera singleton), pairing wiring
  (root convert-tap pair + downstream exact undistort pair + enrichment fan-in),
  UI (RecordButton + Cmd-R generic over `RecordableContract`), viewer
  descriptor overlay.
- **R-2** (this wave) — review + `FoveaDescriptor.frames` null-widening (cast
  removed) + this close. All gates green (see below).

### Deltas from the ruled design

- **Descriptor L/R pointers come from PAIR RECORDS, not a bespoke matcher.**
  Ruling 3/4 named the descriptor shape; the L/R `frames` pointers are
  enriched by re-keying the pairing-nodes root pair record's matched
  deviceTimestamps onto the recorder's `dts→seq` maps (built in the
  `onFrame(stream, seq, deviceTs)` notice). This is why pairing-nodes is the
  descriptor channels' "first consumer" in the concrete.
- **`/zlib` sibling advert re-based on the SOURCE frame identity** (soak find,
  I-2b): the compression brick forwards the source frame's `width/height/origin`
  per blob, so the sibling advert keeps the source `maxWidth`/`maxHeight`
  (`offer()` guards width>maxWidth — core test 32); only `maxBytes` grows to
  the zlib worst case. The variable per-frame length rides ring-v5
  `payloadBytes`, never a dim computation.
- **`significantBits` injected JS-side at connect** (ruling 8): the native
  `PipeSpec` drops it (C++ derives it from the format enum, which a
  codec-suffixed `pixelFormat` would lose), so the advertiser carries it and
  the recorder connect seam copies it verbatim for BOTH raw and `/zlib` pipes —
  fixes the `?? 0` U16-scale hazard.
- **Extras `volt.source: "fin-averaged"`** — the L/R extras are sourced from
  the pairing anchor (a real FIN outcome, trigger-only), so the FIN-sourced
  provenance token applies (matching capture-recorder). Ruling 1's phrasing
  "live-snapshot now" anticipated a per-frame controller snapshot; the shipped
  path has no live-snapshot leg — free-run has no anchor, hence NO extras (not
  a snapshot). The actual exposure-AVERAGING of the FIN value is the separate
  `fin-exposure-voltage` firmware-v2 item; the token denotes source, not algo.
- **`FoveaDescriptor.frames` widened to `number | null`** (R-2) — the recorder
  type now models absent pointers as explicit null, removing I-2b's cast.

### Residuals (rig / follow-on rulings)

- **Observation-driven vs pair-driven descriptor emission** (OPEN follow-on
  ruling): descriptors are emitted per tracker batch (a center observation);
  the FIN pair for that exposure may land slightly later. The controller binds
  the latest FRESH pair (`PAIR_FRESH_MS`, below) — so a descriptor emitted just
  before its pair arrives binds to the previous round's pair or to null. This
  is acceptable for offline reconstruction today (a neighbouring L/R frame);
  a stricter defer-until-pair or pair-driven emission wants a user ruling.
- **`PAIR_FRESH_MS` = 1000 ms tuning** — the round-robin revisits each target
  far faster than this in live capture; rig-tune if target count × dwell
  approaches it (a stale pair past the window degrades to null L/R).
- **Compression path still writes the source ring** — a `/zlib` stream both
  feeds the compression brick AND keeps its source raw12p ring producing
  (the brick is a normal FIFO consumer of it). Decoupling a
  compress-ONLY stream from writing the uncompressed source is a possible
  optimization, not ruled.
- **Viewer overlay is undistorted-bbox over the recorded (distorted) wide
  frame** — the tracker bbox is in undistorted center coordinates; the
  recorded `center` stream is raw12p (packed, distorted). "Minimal playback"
  (ruling 6) honors "bbox on wide"; exact overlay fidelity is a rig-gated
  reconstruction concern, not a live-path fix.
- Rig checklist: `docs/hardware/stage-f.md` §"Multi-fovea recording".

### Final gates (R-2)

`cd core && make` → 0 (ninja no-op, already built); `core/test/28..33` → all
exit 0 from repo ROOT; app `vue-tsc --noEmit` → 0; `vitest run` → 531/531;
`vitest run -c vitest.soak.config.ts` → 4/4 TWICE; `vite build` → 0
(orchestrator 291.35 kB). No Electron launched.
