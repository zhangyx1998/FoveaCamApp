# Eliminate the JS view-tap loop (WS1 real-1f)

Planner brief — 2026-07-08. Migration + dead-code removal. B+C are design-first
(sketch the in-process-vision seam + questions, I rule, then build). A (profiler)
runs in parallel on the observability half.

## The confirmed problem (from the user's snapshots)

In every vision app (disparity-scope, tracking-single, manual-control) the
registry JS view-tap loop is PEGGED:

```
registry:<serial>  util 0.94–0.997  @ ~40fps   ← frame.view("BGRA8") per frame, per camera
camera:<serial>    util 0           (parked)    ← the native converter thread is UNUSED here
```

manage-cameras is smooth precisely because it has NO view-taps → the converter
thread (real-1e) does its conversion off-loop and the JS loop never runs. The
three vision apps still convert on the JS event loop → ~20fps cap + the ~40Hz
serial (actuation `await`s share the same starved loop).

## Goal: eliminate the old path COMPLETELY

Delete, don't deprecate:
- `registry.ts` `startLoop` / `stopLoop` / `viewSinks` / `onView` / `tapView`
  (the JS `frame.view("BGRA8")` loop).
- The `session.frame()` / `useFrames()` VIEWER preview path where a native pipe
  can replace it (the vision apps' raw previews).
- `frame-worker.ts` if it's freed (its only role is gating `onView` sinks).
- `async-kcf.ts` + `app/test/async-kcf-tracker.test.ts` (superseded by the
  native `KcfTrackerStream`, real-1d) — confirmed dead.
- Any view-tap plumbing left stranded (e.g. `registry` `tapView`, `Shared.workload`
  "registry:<serial>" meter once the loop is gone).

After this, the registry is a pure lease broker: acquire/release a shared
`Camera` + advertise/attach its pipe. No per-frame JS work for ANY app.

## Two halves

### Renderer preview → the pipe (mechanical)
Every vision app's raw preview moves from `session.frame()/useFrames` to
`usePipeFrame("camera:<serial>")`, exactly like manage-cameras + calibrate-
intrinsic already do. The session advertises + attaches the camera pipe on
acquire (registry already has `advertiseCameraPipe`/`retireCameraPipe`). This
alone removes the DISPLAY consumers.

### In-process vision → off the JS event loop (THE design question — B leads)
The hard part. Today in-process vision (disparity matching on L/R foveas,
manual-control center-targeting, calibration detectors) consumes the BGRA Mat
via `onView` on the JS loop; the conversion (`frame.view`) is the 99% util.

The registry loop only drops to zero if these consumers ALSO stop pulling
`frame.view` on the JS loop. Options for B to sketch (pick/justify):
- **(a) Native vision threads** — like `KcfTrackerStream` (real-1d): each
  vision op becomes a `TransformStream<Frame::Ptr, Result>` on its own thread,
  consuming the camera stream latest-wins, emitting only final results (points/
  disparity/bbox) back via async-generator. The orchestrator forwards results,
  never touches per-frame pixels. This is the "thin coordinator" north star and
  the most complete elimination — but the biggest lift (disparity matcher,
  detectors → native).
- **(b) In-process converter subscriber feeding a latest-wins worker** — a
  native subscriber on the `ConverterStream` (real-1e) hands the already-BGRA
  Mat to the existing `frame-worker` latest-wins gate, so vision runs off the
  *hot* path without re-converting. Smaller, but a converted frame still crosses
  native→JS per processed frame (bounded by the worker, not the camera rate).
- Note which vision is ALREADY native (marker detector `detector.stream`, KCF)
  and only needs to keep consuming `camera.stream` directly — those may need no
  migration, just decoupling from the deleted registry loop.

Recommend staging: (a) where a native op already exists / is cheap; (b) as the
bridge for JS-only vision that can't be nativized this round. **The DoD is
`registry:<serial>` util → ~0 (loop deleted), NOT necessarily every op native.**

## Ownership / split

- **B (migration core seam):** design + build the in-process-vision-off-loop
  seam (above). Any native converter/vision-consumer additions. Coordinate the
  seam shape with C so the session side is buildable.
- **C (migration orchestrator/renderer):** delete `startLoop`/`onView`/
  `viewSinks`/`tapView` from `registry.ts`; migrate disparity-scope /
  tracking-single / manual-control sessions + their `index.vue` previews to
  `usePipeFrame` + B's vision seam; delete `async-kcf.ts` (+ its test) and
  `frame-worker.ts` if freed; drop the now-dead "registry:<serial>" meter.
- **A (profiler + StreamView metrics — separate, parallel):** owns
  `ProfilerWindow.vue`, `StreamView.vue`, `pipe-consumer.ts` + `protocol.ts`
  (`FramePayload.meta`), `metering.ts`. Does NOT touch registry/sessions.

## DoD

Re-snapshot proves `registry:<serial>` is gone / ~0 util; the three apps hit
camera-native fps; the deleted modules are gone (grep-clean, no dangling
imports). Standing gates: core build both runtimes; native 08-12; vue-tsc 0;
vitest; vite build; zero-Vue/zero-core; V11 triplet; reader otool. Behavior-
preserving (vision results unchanged) but hardware-facing → rig-gated.
