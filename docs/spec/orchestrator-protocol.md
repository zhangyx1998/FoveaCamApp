# Orchestrator client protocol — behavior spec

Behavioral contracts for the renderer↔orchestrator client library (`app/lib/orchestrator/*`).
Renderer-safe, Vue-free, core-free (type-only imports). Source pointers are per section;
the code carries only load-bearing invariants inline.

## Graph topology contract {#graph-contract}

Source: `app/lib/orchestrator/graph-contract.ts` (types only, zero runtime)

The orchestrator's stream node graph: every producing endpoint (camera source, converter,
undistort, KCF, detector, fovea crop, vision kernels) and every consuming endpoint
(renderer views, worker inputs, recorder) is a NODE with a unique path-like id (= its
output stream id); connections are EDGES carrying the stream's type + measured flow. Stats
fold from the existing meters (native ThreadMeter probes, pipe meters, JS
WorkloadSnapshot) — same numbers the profiler tables already show, keyed onto the graph.

### Id scheme

`/`-separated paths, two roots:
- `camera/<serial>[/...]` — shared resource bricks, broker-owned, refcounted (e.g.
  `camera/123`, `camera/123/convert`, `camera/123/undistort`, `camera/123/kcf`,
  `camera/123/undistort/fovea/2`).
- `win/<windowId>/[...]` — window-composed nodes (renderer-demanded, lifetime = the
  composition; e.g. `win/tracking-1/display`).

A format access modifier stays in the last segment as `@<PixelFormat>` only when a SECOND
simultaneous format of the same stream exists; the default format is unsuffixed and lives
in the type. `ContainerDtype` = the sensor schema's decoded dtypes plus "F32" for DERIVED
float pipes (the stereo brick's disparity map — not a sensor format: no PIXEL_FORMATS row,
no renderer decode path).

## SHM transfer pool (shm-client) {#shm-client}

Source: `app/lib/orchestrator/shm-client.ts`

The canonical preview transport hands the renderer an `shm` descriptor, not pixels: the
actual read runs in the unsandboxed main-window preload (which alone can load the native
reader addon), and the bytes come back over a dedicated `MessagePort` as a TRANSFERRED
`ArrayBuffer`. This module owns that port handshake, the ping-pong buffer pool that
recycles transferred buffers (so a steady stream doesn't churn allocations), the per-read
timeout, and the message protocol with the preload. `client.ts` just calls `read()` in its
frame flush and `release()` when a materialized frame is replaced/dropped.

### Buffer-ownership invariants (mirrored by shm-client.test.ts)

MessagePort transfer moves ownership away and back — this is the whole ballgame:
- success → buffer becomes `payload.data`; caller returns it via `release()` once the frame
  is displaced.
- null → no new frame this read; buffer is reclaimed to the pool here.
- error → buffer reclaimed to the pool here; read rejects (→ null).
- timeout → read rejects; the buffer is still in the preload's hands, so it is reclaimed by
  the STALE-response path when the late read-done arrives with no matching pending entry.
- stale → read-done with no pending entry (already timed out / disposed) → buffer reclaimed
  to the pool.

## Pipe contract {#pipe-contract}

Source: `app/lib/orchestrator/pipe-contract.ts`

The orchestrator ADVERTISES typed SHM pipes; a renderer selects one by id, `connectPipe`s
ONCE to get a `PipeHandle`, then reads pixels per-frame straight from the shared segment via
the reader addon (`reader.readInto(handle, dest, lastSeq)`, dest reused). Nothing rides the
Channel per-frame (`frames: []`, no per-frame descriptor). The publisher (a C++ thread,
`core.Pipe`) owns the segment. `PipeSpec` IS the explicit frame typing: `bytesPerFrame` /
`dtype` / `pixelFormat` are declared up front, so raw/16-bit/packed pipes are sized and
decoded correctly instead of inferred from shape; `pixelFormat` / `dtype` are the canonical
values from the single schema, imported read-only. Vue-free.

## Orchestrator client {#client}

Source: `app/lib/orchestrator/client.ts`

Renderer-side orchestrator client: wraps the RPC `Channel` in Vue's reactive shape so
modules read/write authoritative orchestrator state as if it were local. `state` → reactive
mutable object (property set = command; value tracks the server echo); `telemetry` →
reactive readonly (subscription-driven); `frame(name)` → readonly Ref (dynamic keys,
latest-wins, coalesced to one rAF); `call(name, arg)` → Promise of the command result. All
authoritative state lives in the orchestrator; the renderer holds only echoes, so multiple
windows stay consistent for free. `state`/`telemetry` keys are enumerated once from the
contract's default POJOs at `useSession()` time, so every key is live immediately.

## Spin-up progress model {#progress}

Source: `app/lib/orchestrator/progress.ts`

A session declares an UPFRONT list of steps at the start of its activation and transitions
each one (pending → active → done) as it works; the list rides the per-session STATUS
channel (`SessionStatus.progress`) so every subscribed window renders a progress overlay
generically — no typed contract per app. Renderer-safe and Vue-free on purpose, and a LEAF
(no import of runtime.ts / protocol.ts) so `SessionStatus` in protocol.ts can reference
`ProgressItem` without an import cycle.

## PID-override contract fragment {#pid-override-contract}

Source: `app/lib/orchestrator/pid-override-contract.ts`

The single, module-agnostic definition of the state field + command that expose a PID node's
override slot across the orchestrator↔renderer boundary (a pointer drag pins the output while
the control law is held reset) — the role a per-module `contract.ts` plays, factored out so
ANY module gets the identical shape. Strictly Vue-free (imports only
`@lib/orchestrator/protocol`): module contracts are imported by the orchestrator bundle too,
so pulling Vue here would break the Vue-free-orchestrator rule. The renderer proxy that
consumes it (`usePidOverride`) lives in the client lib; the orchestrator mapping
(`applyPidOverride`) lives in `@orchestrator/pid-node`.

## RPC channel {#protocol}

Source: `app/lib/orchestrator/protocol.ts`

Transport-agnostic RPC duplex shared by the orchestrator process and the renderer client. It
knows nothing about Electron or Vue — it speaks over an `Endpoint` (a minimal
postMessage/onmessage pair), so the same `Channel` runs on a DOM `MessagePort` (renderer) and
an Electron `MessagePortMain` (orchestrator). Three message shapes ride one channel:
request/response (commands, queries — correlated by id), event (state + telemetry —
fire-and-forget, by topic), and frame (display payloads — by topic, carries a buffer).

## Camera-probe contract {#probe-contract}

Source: `app/lib/orchestrator/probe.ts`

The camera-enumeration probe contract + pure helpers. The probe process, main, and the
Welcome renderer all share these types + the pure list-diff / status derivation so there is
one source of truth, unit-testable without Electron or a camera. Renderer-safe and Vue-free.
(The probe process itself is `orchestrator/probe.ts` — see
docs/spec/orchestrator-runtime.md#probe.)

## Pipe consumer loop {#pipe-consumer}

Source: `app/lib/orchestrator/pipe-consumer.ts`

Renderer-side pipe consumer loop: given a `PipeHandle` (from `connectPipe`), it polls the
segment through the preload reader addon (`io.readPipe` — reuses the shared buffer pool), tracks
`lastSeq` itself, and emits `FramePayload`s to a display sink. On the explicit CLOSED signal
it stops and releases its buffers. Nothing per-frame crosses the Channel — the JS handshake
happened once at connect. Vue-free (the display ref/binding lives in `client.ts`); `io` is
injected so tests drive it with a scripted reader.
