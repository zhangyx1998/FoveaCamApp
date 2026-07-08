# Modular per-stream format-converter threads (WS1 real-1e)

Planner draft — 2026-07-07. Design-first: coders post a sketch + questions
before building (seam-review gate).

## Motivation

The camera→pipe producer currently converts inline in `feedPipe` on the
`Arv::Stream` capture thread, with the conversion logic **duplicated** from
`Frame::view`. That duplication just caused a real bug: `feedPipe` omitted the
16-bit→8-bit down-scale `Frame::view` does, so 12-bit/16-bit camera formats
(BayerRG12p, Mono16, …) rendered as colored stripes (fixed inline in
`466a9ce`, but the duplication remains a trap).

User directive: make the converter a **modular, reusable** component; run it on
a **dedicated thread attached to each stream's output**, selected by a
**modifier on the stream/pipe request**; and keep these producer threads
**idle when no pipe is open**.

## Key enabling fact

The `Stream<T>` base (`core/lib/Stream/Stream.h`) already **auto-parks**: its
thread `wait_activate()`s while `subscribers.empty()`, is lazily spawned on the
first `subscribe()`, and when subscribers drain to zero it runs `stop()` then
re-parks. `TransformStream<I,O>` (`core/include/Iterator.h`) builds on it:
`start()` creates a `Sub::Latest<I>` on `upstream()` (latest-wins, drop-stale,
exposes `upstreamDrops()`); `KcfTrackerStream` is the working template.

**Therefore "idle when no pipe" is free and propagates:** no pipe consumer →
the pipe's subscriber detaches from the converter → the converter drains to
empty → its base thread `stop()`s (destroying its `Sub::Latest` on the camera
`Arv::Stream`) and parks → the camera stream, if it now has no subscribers
(no vision taps), parks too. A preview-only camera with no open pipe fully
idles, with **no new lifecycle code** — we lean on the existing machinery.

## Design

### 1. `FrameConvert` — one converter, single source of truth  (B)

Extract the conversion (currently in both `Frame::view` and `feedPipe`) into
one reusable function, e.g. in `core/lib/Aravis/`:

```cpp
// cvtColor(raw, out, cvtColorCode(src,dst)) then, if dst is 8-bit but the
// cvtColor result is >8-bit (Mono16/Bayer16/12p → raw is CV_16UC1), scale to
// true 8-bit by significantBits(src): out.convertTo(out, 8U, 255/(2^bits-1)).
void convertFrame(const cv::Mat& raw, PixelFormat src, PixelFormat dst,
                  cv::Mat& out);
```

Retrofit `Frame::view` to call it (kills the duplication that caused the
stripe bug). Reusable-buffer semantics preserved (caller passes `out`).

### 2. `ConverterStream : TransformStream<Frame::Ptr, ConvertedFrame::Ptr>`  (B)

A dedicated converter thread per **(camera stream × target format)**, modeled
on `KcfTrackerStream`:

- `upstream()` = the camera's `Arv::Stream`; base `start()` creates the
  `Sub::Latest` (latest-wins).
- ctor takes the **target `PixelFormat`** — this *is* the converter selection.
- `transform(frame)` → `convertFrame(frame->raw, frame->format, target_, buf_)`
  into a reused buffer; returns a `ConvertedFrame::Ptr` carrying the converted
  `cv::Mat` + `device/system_timestamp` (+ convertMs).
- Carries a `ThreadMeter` (instrumented like the tracker) → `probe()`able
  out-of-loop; meter `upstreamDrops()` as the "camera outran the converter"
  drop signal.

### 3. Pipe producer subscribes to the ConverterStream  (B + C seam)

The Pipe's `FrameSink` is driven by a thin `Subscriber<ConvertedFrame::Ptr>`
on the ConverterStream (replacing today's `CaptureSink` that subscribes to
`Arv::Stream` and convert+offers inline). `push(cf)` → `sink.offer(cf->mat.data,
info, meta)` (info/stride/bytes computed from the already-8-bit `mat`; the
producer copy stays the same). Pipe refcount>0 ⇒ subscriber attached (wakes the
converter); refcount 0 ⇒ detached ⇒ converter parks (see "idle" above).

This moves heavy Bayer/12p demosaic **off the capture thread** onto its own
instrumented, auto-parking thread — consistent with the "free-running C++
threads, orchestrator is a thin coordinator" milestone.

### 4. Request modifier — the converter selector  (A + C)

`PipeSpec.pixelFormat` already carries the target ("BGRA8"); formalize it as the
converter selector. `attachCameraPipe` reads the spec's target `PixelFormat` →
constructs the `ConverterStream` for (cameraNativeFormat → target). The seam is
general (any src→dst `cvtColorCode` supports); the only current instantiation is
the BGRA8 preview, but a future fovea pipe can request a different target
without touching this layer. Keep `feedTestFrame` working (drive the converter
or `convertFrame` directly).

## Instrumentation

Fold the ConverterStream's `ThreadMeter` into `perfSnapshot.workloads` via the
existing `probe()`/`probeAll()` path (same as tracker + pipe producer), so the
profiler shows converter rate / util / maxInterval / drops per camera.

## Retirements

- `CaptureSink` (inline convert on the capture thread) → replaced by
  `ConverterStream` + the thin Pipe subscriber.
- `feedPipe`'s inline convert → `convertFrame` (shared with `Frame::view`).

## Ownership / split

- **B** (`core/lib/Aravis`): `convertFrame` extraction + `Frame::view` retrofit;
  `ConverterStream` + `ConvertedFrame`; rework `attachCameraPipe`/`detach` to
  create/hold the ConverterStream + Pipe subscriber keyed by pipeId; retire
  `CaptureSink`; keep `feedTestFrame` + `11-capture-pipe` (incl. the Mono12p
  regression) green; converter `ThreadMeter`.
- **C** (`core/src/Pipe.cpp`, `core/include/Pipe.h`): the Pipe-side subscriber
  adapter (ConverterStream output → `FrameSink::offer`); confirm the
  request-modifier (`spec.pixelFormat` → target) surfaces cleanly; converter
  meter fold-in / `probeAll` shape if it rides the pipe's probe.
- **A** (orchestrator TS): thread the target-format modifier through the
  advertise/attach seam (`advertiseCameraPipe` already sets `pixelFormat`);
  register the converter probe into `perfSnapshot.workloads`. Likely small.

## DoD

Standing gates (both runtimes build; native 08–12 incl. Mono12p regression;
vue-tsc 0; vitest; vite build; zero-Vue / zero-core; V11 triplet; reader addon
`otool`). Preview-only camera with no open pipe shows the converter + camera
threads **parked** (no CPU). Rig: 12-bit preview renders clean; capture thread
util drops (demosaic moved off it).
