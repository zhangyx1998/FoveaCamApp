# core frame bricks (Converter / Raw / Stereo)

Behavior spec for the Aravis frame-processing bricks. Design rulings live under
`docs/proposals/` (`native-port-pipe`, `stereo-disparity-and-heatmap-nodes`,
`stereo-throughput`, `capture-recorder-nodes`, `multi-fovea-recording`); this
file records the runtime invariants the code carries `// spec:` pointers to.

## converter {#converter}

`ConverterStream` (`core/lib/Aravis/ConverterStream.h`) is the per-stream format
converter thread (B-18), replacing the inline-convert `CaptureSink`. A dedicated
thread per (camera × target format) runs the SHARED `convertFrame` (raw→display,
incl. the >8-bit down-scale) OFF the capture thread; a thin B-owned `Subscriber`
offers the converted bytes to C's pipe `FrameSink`. Both auto-park when the pipe's
consumers drain (the `Stream` base parks on empty subscribers — no lifecycle
code).

## reuse-contract {#reuse-contract}

`ConvertedFrame.mat` IS the ConverterStream's REUSED buffer (a header over it),
valid ONLY during the synchronous dispatch to subscribers — the existing onView
view-tap contract ("the Mat is the reused buffer; copy out to retain"). The single
pipe subscriber's `offer()` copies it into the ring inline, before the next frame
overwrites the buffer. Any future BUFFERING consumer of a ConverterStream MUST
copy. `ConvertedFrame.format` is stamped so in-process taps can carry the frame's
typing without consulting the producer. `originX/originY` are the fovea crop origin
in SOURCE coordinates, FRAME-BOUND to this product (a JS rect echo races); they
flow through `FrameInfo` into the v4 slot header.

## owned-frame {#owned-frame}

`OwnedFrame` (unified-time-and-topology §5) is the OWNED element type of the
in-process brick→brick Leaky tap. Unlike `ConvertedFrame` (a header over the
producer's REUSED buffer), an `OwnedFrame.mat` OWNS its heap buffer — the tap
publisher deep-copies at publish time, so ownership transfer (shared_ptr) retires
the reuse-contract hazard: a downstream brick may retain/consume it on its own
thread at its own pace. Allocated ONLY while ≥1 downstream tap is subscribed (zero
cost otherwise — no TapPublisher, no copy). `seq` is a monotonic per-tap sequence;
downstream meters latest-wins drops from the gaps (`seq - lastSeq - 1` frames were
overwritten unconsumed).

## raw-pipe {#raw-pipe}

`RawPipe` (`core/lib/Aravis/RawPipe.cpp`, capture-recorder-nodes Phase 1) applies
the `PipeOfferSubscriber` pattern to the camera SOURCE stream instead of a
converted-frame producer — the recorder/capture nodes need full-bit-depth sensor
bytes, NOT the 8-bit down-scaled BGRA8 preview pipes.

- `attachRawPipe(camera, pipeId)` — subscribe a gated raw producer to the camera's
  `Arv::Stream`; offer `frame->raw`.
- `detachRawPipe(pipeId)` — idempotent (unregister gate + drop binding).
- `rawProbeAll()` — per-pipe ingest/offer meter rows.

**extract-before-release:** the subscriber runs on the camera CAPTURE thread, in
the Stream base's synchronous fan-out; it extracts `frame->raw` and copies it into
the ring (`sink->offer`) BEFORE the Frame is released. The synchronous dispatch
satisfies the hard "extract before release" invariant (the `Frame::Ptr` is alive
for the whole push). CONSUMER-GATED (C-21): no recorder/capture attached → the
subscriber does not exist → zero capture-thread cost.

**12p container:** `Arv::Frame` UNPACKS packed 12p into a 16-bit (CV_16UC1)
container at construction (`Frame.h fromArvBuffer`), then `Stream.cpp` immediately
recycles the ArvBuffer — so by the time ANY `Frame::Ptr` subscriber runs, the
literally-packed bytes are already gone. The raw pipe therefore carries
`frame->raw` = the FULL-BIT-DEPTH container (16-bit for 12p/Mono16, 8-bit for
Mono8), which is what the recorder needs. `pixelFormat` = the sensor format string;
`dtype` (U8/U16) follows the container width. Truly-packed preservation (the
raw12p pipes, multi-fovea-recording ruling 1) taps the ArvBuffer BEFORE Frame
construction via `Arv::Stream::BufferTap` and publishes the verbatim packed wire
payload.

## stereo {#stereo}

`StereoStream` (`core/lib/Aravis/StereoStream.h`) is the FIRST two-input chained
brick. It has TWO input modes, chosen at CONSTRUCTION (session recompose on trigger
start/stop), never a runtime switch. Output advert + timestamps (the LEFT frame's,
never re-stamped) are identical in both modes.

**latest-wins mode** (stereo-disparity-and-heatmap-nodes): both inputs are
OwnedFrame taps (Leaky/latest-wins) on any frame brick (undistort / convert /
fovea / scale). The brick opens TWO TapPublishers in `start()` (closed in `stop()`)
so demand propagates to BOTH sources; either source terminating ends the brick.
Pairing: tick on every LEFT arrival, matched with the LATEST RIGHT frame (no seq
comparison — different owner clocks pace them). `iterate()` BLOCKS on the left
channel, then drains the right non-blocking keeping only the newest, retaining the
last-seen right across ticks. No right frame yet → skip. Output timestamps/origin =
the LEFT frame's; active out dims = left.

**paired mode** (stereo-paired-inputs, ruled 2026-07-09): the SGBM join over
EXPOSURE PAIRS. Instead of two latest-wins taps, it chains on the always-running
`PairStream` brick with ONE record tap, running SGBM per `PairRecord` — L/R matched
by construction (anchored on the FIN), no in-brick anchor matching (tolerance-once
ruling). On-demand like the latest-wins brick (parks with no consumers → the record
tap unsubscribes; the pair brick's keep-alive is unaffected).

**compute** (stereo-throughput, ruled 2026-07-10): BGRA→GRAY both sides, then a
SWAPPABLE matcher — `cv::StereoSGBM` (mode SGBM / 3WAY / HH) or `cv::StereoBM` —
optionally matched at 1/matchScale resolution (window scaled with it) and
optionally WLS-refined (`cv::ximgproc`, compile-guarded). Output stays CV_32F
disparity with VALUES in full-res LEFT-frame pixel units (scaled matching
multiplies back by matchScale); map DIMENSIONS are emitted at match scale (advert/
reader carry actual dims — consumers must not assume full-res). Input dims must
match (unequal → drop + `meter_.drop`, the transient during steer/retune). Reactive
params (validated NAPI-side, applied on the brick thread): the matcher is rebuilt
when a pending param lands. The `process(left,right)` path, reactive params, F32
left-coords output, and meter surface are SHARED (REUSED) across both input modes.
