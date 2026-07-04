# Stream Hot-Path Refactor

> **Status:** Initial cleanup landed. **[planner, 2026-07-04]: this doc has
> been quiet since 06-28 and its Verification section is stale — the
> vue-tsc errors it cites were since cleared, and `core make build` now
> builds clean on both runtimes (rebuilt repeatedly by the protocol-v2
> thread). The listed changes read as complete and the JS-facing API
> contract has held through two downstream migration rounds. Please
> confirm whether this thread is done — it is the gate on the
> disparity-scope migration (orchestrator.md §7), which is now the largest
> remaining piece of the refactor's primary objective and otherwise ready
> to proceed code-side.**
> **Branch:** `refactor/decouple-orchestrator`
> **Last updated:** 2026-06-28 (annotation 2026-07-04)

This note tracks stream-specific cleanup that is separate from the orchestrator
process migration. The goal is to reduce native/JS stream overhead while
preserving the current JS-facing API.

## Completed Changes

- `core/lib/Stream/Stream.h` — stream worker threads are lazy-created on first
  subscription instead of at `Stream` construction. Camera enumeration can create
  `Camera.stream` handles without spawning unused native threads.
- `core/lib/Aravis/Stream.cpp` — Aravis acquisition uses
  `arv_stream_timeout_pop_buffer` so shutdown/disconnect can break out of a
  stalled pop promptly.
- `core/include/Iterator.h` — async iterator subscribers keep a bounded native
  backlog and drop oldest stale frames if a JS consumer falls behind, preventing
  unbounded queued `Frame` growth.
- `core/dist/types.d.ts` — `Stream<T>` async-iterator comments now document
  bounded backlog semantics.
- `app/modules/disparity-scope/index.vue` — the renderer-side control loop
  reuses BGRA conversion buffers for L/C/R frame views before wrapping fovea
  images, reducing per-frame allocation pressure while this loop still lives in
  the renderer.

## API Compatibility

The current JS-facing shape is preserved:
- `camera.stream`
- sync latest-frame iteration
- async iteration
- `Frame.view(format, buffer?)`

The intentional semantic tightening is that async iteration no longer promises
unbounded lossless queuing. Slow consumers may drop stale queued frames after the
bounded native backlog fills.

## Verification

- Source-only C++ checks passed for the touched stream-related translation units
  using current `pkg-config` paths.
- `vue-tsc --noEmit -p app/tsconfig.json` still fails on the same pre-existing
  unrelated errors in `manual-control`, `tracking-single`, and `Controller.vue`.
- Full `core make build` is blocked by stale generated CMake/Ninja paths pointing
  at old Homebrew cellars (`libusb 1.0.29`, `glib 2.86.3`) while the system has
  newer versions installed.
