# Coder B Optimization Survey

Ranked proposals for B-owned surfaces: `core/**` minus SHM reader/ring,
`firmware/**`, `pyfovea/**`, `app/orchestrator/recorder/**`, and
`playground/bench-recorder/**`.

## B-P1 — Single PixelFormat/Dtype Registry

- **Locations:** `core/lib/Aravis/PixelFormat.{h,cpp,ts}`,
  `core/dist/Aravis/index.d.ts`, `app/lib/util/dtype.ts`,
  `pyfovea/src/pyfovea/dtypes.py`, recorder/viewer metadata consumers.
- **Current → proposed:** Hand-maintained C++ enum/switches, TS unions,
  Python dtype maps, Bayer lists, `significantBits`, and `isPacked` →
  one declarative registry, likely JSON/YAML or a small TS source table,
  generating C++ tables, TS types, Python maps, and fixtures.
- **Category:** non-breaking.
- **Rationale:** The same 12p facts are repeated in at least six places.
  `PixelFormat.cpp` alone repeats the 19-format list across Aravis→internal,
  string↔internal, internal→Aravis, cv format, conversion tables, and bit
  helpers. The current `core/dist/Controller/index.d.ts` already has a stale
  `CAPACITY = 8` comment after firmware moved to 64, which is the drift class
  this would reduce for format metadata too.
- **Effort:** M.
- **Risk:** Medium. Generated code must preserve export names and comments
  around 12p unpack semantics.

## B-P2 — Shared 12p Pack/Unpack Test Vector Contract

- **Locations:** `core/lib/Aravis/Frame.h`,
  `playground/bench-recorder/src/synth.ts`,
  `pyfovea/src/pyfovea/dtypes.py`, `pyfovea/tests/test_dtypes.py`.
- **Current → proposed:** Three independent implementations of GenICam
  `*12p` bit layout plus test-local pack helpers → a tiny cross-language
  fixture set (`samples.json` + packed bytes) and tests in C++/TS/Python
  asserting the same odd/even pixel cases.
- **Category:** non-breaking.
- **Rationale:** The bit layout is load-bearing for raw recording and ML
  decode. A one-bit drift would still compile and could pass single-language
  tests if pack/unpack share the same bug.
- **Effort:** S.
- **Risk:** Low. Adds fixtures/tests only; no runtime API change.

## B-P3 — Pin Recorder Schema as Code, Not Comments

- **Locations:** `app/orchestrator/recorder/index.ts`,
  `app/orchestrator/recorder/types.ts`,
  `app/orchestrator/recorder/worker-source.ts`,
  `pyfovea/src/pyfovea/{fovea.py,convert.py}`,
  `playground/bench-recorder/src/{protocol.ts,writer-worker.ts}`.
- **Current → proposed:** Schema names, encodings, telemetry topic,
  metadata keys, chunk default, and README wording are repeated as strings →
  one versioned schema contract file, with TS constants and a generated
  Python module consumed by pyfovea.
- **Category:** non-breaking.
- **Rationale:** B owns the `.fovea` schema contract. Today production writer,
  pyfovea converter, reader docs, and bench spell out related but not identical
  schema names (`fovea.raw_frame/v1` vs bench `fovea.raw12p`) and message
  encodings (`x-fovea-raw` vs bench `raw`). That is acceptable for a bench,
  but a shared contract would make future v2 schema changes deliberate.
- **Effort:** M.
- **Risk:** Medium. Requires care to keep Python packaging source-of-truth
  available without importing app code.

## B-P4 — Make the Recorder Bench Drive the Production Writer Protocol

- **Locations:** `playground/bench-recorder/src/{bench.ts,protocol.ts,writer-worker.ts}`,
  `app/orchestrator/recorder/{writer.ts,types.ts,worker-source.ts}`.
- **Current → proposed:** Bench maintains its own worker protocol, MCAP writer
  init, channel registration, compression path, and ack/backpressure counters
  → bench a thin harness around the production recorder writer/worker with
  optional compression knobs injected behind a bench-only interface.
- **Category:** non-breaking.
- **Rationale:** The bench found the MCAP single-writer bottleneck, but it now
  tests a sibling implementation. Production changed to `x-fovea-raw`,
  telemetry channels, eval CJS worker source, and workload metering after the
  bench was written. Reusing the production write path keeps future throughput
  numbers tied to the code users run.
- **Effort:** M.
- **Risk:** Medium. The bench must keep its compression experiments without
  promoting compression into production defaults.

## B-P5 — Generate Protocol JS Factories and `.d.ts` from Packet Specs

- **Locations:** `lib/Protocol/Packet.h`, `core/src/Controller.cpp`,
  `core/dist/Controller/index.d.ts`, `firmware/src/Protocol.cpp`,
  `core/test/02-serial-protocol.ts`.
- **Current → proposed:** N-API packet factories, TS argument/result types,
  and firmware handler expectations are hand-mirrored around `Packet.h` →
  add a small protocol schema layer or codegen step that emits JS factory
  bindings and declaration types from one packet description.
- **Category:** non-breaking if emitted APIs stay byte-for-byte compatible.
- **Rationale:** `Controller.cpp` is 1116 lines and much of it is boilerplate:
  object↔packet conversion, factory registration, special ACK/FIN shapes,
  and TS declarations. The stale `MirrorStreamArg.id` comment (`CAPACITY = 8`
  while firmware is 64) is direct evidence of drift in the hand-maintained
  surface.
- **Effort:** L.
- **Risk:** High. Native addon generation affects build/debug ergonomics and
  must preserve Node-API behavior exactly.

## B-P6 — Replace Two-Phase Request Special Cases with a Native Request FSM

- **Locations:** `core/src/Controller.cpp`, `firmware/src/Protocol.cpp`,
  `firmware/src/Capture.cpp`, `lib/Protocol/Packet.h`.
- **Current → proposed:** `isTwoPhase`, `PendingRequest`, cached
  `FrameAccepted`/`FrameResult` factories, and firmware ACK/FIN timing are
  encoded as scattered special cases → explicit request-state metadata per
  property: phase policy, ACK decoder, FIN decoder, timeout/retire rule.
- **Category:** non-breaking.
- **Rationale:** P4.1 FIN tracing fixed subtle pending-map and resolve-order
  bugs. The two-phase behavior is now critical enough to deserve a table/FSM
  rather than open-coded `if (property == CMD_FRAME)` branches.
- **Effort:** M.
- **Risk:** Medium-high. The FIN timeout area is hardware-gated; test harness
  must include v1 fallback, ACK-only, ACK+FIN, REJ-at-ACK, and REJ-at-FIN.

## B-P7 — Chunked Serial Reads in the Host Rx Loop

- **Locations:** `core/src/Controller.cpp`, `COBS::RX` usage,
  `core/test/02-serial-protocol.ts`.
- **Current → proposed:** `rxLoop()` reads one byte at a time and logs each
  incoming byte → read a small stack buffer, feed bytes through COBS in a loop,
  and summarize trace logs per decoded packet.
- **Category:** non-breaking.
- **Rationale:** Firmware ST-64b removed the one-byte MCU intake ceiling, but
  the host still uses one-byte `read()` syscalls. With 64 streams and FIN trace
  logging, the syscall/log overhead can distort the very serial-throughput
  measurements Stage F is meant to collect.
- **Effort:** S.
- **Risk:** Low-medium. Needs care to preserve COBS packet boundaries and the
  existing trace format around decoded packets.

## B-P8 — Generic Firmware PendingAction Helper

- **Locations:** `firmware/src/Protocol.cpp`.
- **Current → proposed:** `actuatePending/Seq/Result/Due` and
  `triggerPending/Seq/Result/Due`, plus nearly identical cancel/tick/send
  logic → a small `PendingAction<T>` helper for ACK-now/FIN-later commands.
- **Category:** non-breaking.
- **Rationale:** Actuate and Trigger are the same state machine with different
  payload types and completion hooks. The duplicate blocks are small today,
  but this is the firmware path where P4.1 had the most expensive live-debug
  cycle; reducing duplication lowers the chance of fixing one command and
  missing the other.
- **Effort:** S.
- **Risk:** Medium. Firmware template/debug output must remain readable on
  Teensy and not increase binary size meaningfully.

## B-P9 — Firmware Capture Queue as a Named Ring Buffer

- **Locations:** `firmware/src/Capture.cpp`, `firmware/include/Capture.h`.
- **Current → proposed:** Manual `queue[]`, `queueHead`, `queueCount`,
  modulo indexing, duplicate-stream scan, and cancel drain → a tiny fixed
  `Ring<Request, QUEUE_CAPACITY>` with push/pop/for_each/drain helpers.
- **Category:** non-breaking.
- **Rationale:** Capture's queue is correct but hand-rolled across enqueue,
  start, duplicate detection, and cancel paths. The same invariants will be
  revisited during bench tuning if queue depth or fairness changes.
- **Effort:** S.
- **Risk:** Low-medium. Avoid dynamic allocation and keep ISR-free ownership
  clear.

## B-P10 — Streaming pyfovea Telemetry Join for Large Recordings

- **Locations:** `pyfovea/src/pyfovea/fovea.py`,
  `pyfovea/tests/test_fovea.py`.
- **Current → proposed:** Indexed reads load all telemetry into
  `_telemetry` before yielding frames; recovery stores all recovered messages
  in `_recovered` then sorts → add a streaming mode that yields file-order
  frames with bounded telemetry state, plus an explicit `seekable`/indexed
  mode for timeline use.
- **Category:** breaking if the default iteration order or extras guarantee
  changes; non-breaking if added as `iter_frames_streaming()`.
- **Rationale:** Full ML datasets will be much larger than the tiny fixtures.
  Loading all telemetry and recovered message tuples can turn a reader into
  an accidental whole-file materializer, especially for crash-truncated files
  where the streaming path is mandatory.
- **Effort:** M.
- **Risk:** Medium. The current API promises log-time order and joined extras;
  bounded streaming may need to trade one of those in truncated files.

## B-P11 — Bounded Native Async Worker Pool

- **Locations:** `core/include/AsyncTask.h`, `core/src/Tracker.cpp`,
  async-heavy `core/src/Vision.cpp` callers.
- **Current → proposed:** Some builds use detached `std::thread` per
  `AsyncTask` under `ASYNC_TASK_EXTERNAL`; other builds use `Napi::AsyncWorker`
  → one bounded native worker pool with named queues, cancellation-on-env
  cleanup, and optional workload counters.
- **Category:** non-breaking API, but breaking internally if the build flag
  behavior changes.
- **Rationale:** T6 added `Tracker.updateAsync()` specifically to keep heavy
  work off the orchestrator loop. Unbounded detached native threads can create
  their own saturation under multi-target tracking; a pool makes concurrency
  explicit and measurable.
- **Effort:** L.
- **Risk:** High. Native lifetime, cleanup hooks, and N-API resolve paths are
  fragile; this needs focused stress tests.

## B-P12 — Recorder Full-Res Sharding Topology

- **Locations:** `app/orchestrator/recorder/{types.ts,index.ts,writer.ts}`,
  `pyfovea/src/pyfovea/fovea.py`, viewer contract/readers.
- **Current → proposed:** `singleFileTopology` is the only implemented
  topology; B-4 showed 6.2 MiB raw tier drops 41-71% because one MCAP writer
  serializes all channels → if user requires full-res raw recording, implement
  a sharded topology (for example one `.fovea` per raw camera plus shared
  session manifest, or a merge/finalize step).
- **Category:** breaking.
- **Rationale:** This is the measured bottleneck, not a guess. The current
  contract says one file per dump; sharding breaks that UX but is the clean
  way around MCAP's non-reentrant writer chain for full-res tier.
- **Effort:** L.
- **Risk:** High. Affects file association, viewer open semantics, pyfovea
  API, crash recovery, and user expectations.

## B-P13 — Protocol Capability Negotiation Instead of Major-Version Guessing

- **Locations:** `lib/Protocol/Version.h`, `lib/Protocol/Packet.h`,
  `core/src/Controller.cpp`, `firmware/src/Protocol.cpp`,
  `core/dist/Controller/index.d.ts`.
- **Current → proposed:** Host sets `v2Capable = firmware.major >= host.major`
  after `System.Version` → add an explicit capability bitset or
  `System.Capabilities` packet (`twoPhase`, `frame`, `stream`, `stats`,
  future features), and gate features by capability rather than major math.
- **Category:** breaking protocol addition for firmware/host pairs, though it
  can keep a v1/v2 fallback.
- **Rationale:** The planner already noted that newer-major firmware would
  pass the current check. Capabilities give better mixed-deployment behavior
  once protocol v3 or partial firmware builds exist.
- **Effort:** M.
- **Risk:** Medium-high. Requires firmware flash coordination and mixed-version
  tests.

## B-P14 — Internal Protocol Naming Shortening

- **Locations:** `core/src/Controller.cpp`,
  `core/dist/Controller/index.d.ts`, `firmware/src/Capture.cpp`.
- **Current → proposed:** Keep wire/API names stable, but shorten internal
  names where they obscure state transitions: `frameAcceptedFactory` →
  `frameAckFactory`, `frameResultFactory` → `frameFinFactory`,
  `accepted_settled` → `ackDone`, `completed_settled` → `done`,
  `exposureLatchTranslated` → `latchTimeReady`, `awaitingFallMask` →
  `fallMask`.
- **Category:** non-breaking if limited to internals/comments.
- **Rationale:** The protocol code mixes phase vocabulary (`ACK/FIN`) with
  promise vocabulary (`accepted/completed`). Shorter phase-native names make
  the P4.1 trace logic easier to audit without changing the public
  `accepted` promise.
- **Effort:** S.
- **Risk:** Low-medium. Rename churn can obscure active FIN-trace history, so
  it should wait until after the next bench run unless paired with tests.

