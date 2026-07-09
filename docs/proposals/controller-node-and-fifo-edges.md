# Controller node + FIFO edges (ruled proposal, 2026-07-08)

User directives (planner-ruled into this wave):

1. **Use FIFO for undistort node input.** The undistort brick must process
   every converted frame IN ORDER (no latest-wins skips between convert and
   undistort).
2. **For FIFO-connected edges, report high-water mark in place of package
   drop rate** (profiler graph + snapshot schema).
3. **Allow ctrl/cmd-W to close a window** (planner-direct, one menu role).
4. **Controller becomes a thread node** with both input endpoints (position
   streams; optionally named left/right fovea cameras for trigger-mode fovea
   pair matching) and output endpoints (fovea pairs matched by trigger sync).

5. **Disparity-scope's KCF tracker must leave the disparity-matching thread.**
   Each KCF tracker runs in its own (native) thread, output feeds the
   disparity matcher as the target center; user drags go through the
   TRACKER's override interface, and the tracker's output record carries the
   override flag downstream (matcher → PID vergence controller) so each
   stage acts correspondingly. See §3.5.

A further directive (disparity-scope marker scaling / guide slicing /
drag-release continuity) is dispatched separately to the dedicated
disparity-scope worker; §3.5's drag re-architecture builds on top of it.

---

## §1 FIFO undistort input (worker E, core/)

Current: `ChainedStream` (core/lib/Aravis/ConverterStream.h) taps its source
through `TapPublisher` → `Threading::Leaky<OwnedFrame>` — latest-wins; skips
are metered from `OwnedFrame.seq` gaps (`seqGap`).

Ruled:

- `ChainedStream` gains a **channel-kind** selector at construction:
  `Leaky` (default, unchanged) | `Fifo{capacity}`. **UndistortStream (both
  variants) constructs with `Fifo`, default capacity 8.** FoveaStream stays
  Leaky this wave (crops are previews; latest-wins is correct there).
- FIFO transport = `Threading::FIFO<OwnedFrame::Ptr>` (core/lib/Threading/
  FIFO.h — already has bounded blocking push, close→EOS on both ends,
  `queued_size()`). `TapPublisher` writes into whichever channel the chain
  created; close/EOS semantics must match Leaky's exactly (producer death →
  downstream EOS → StopIteration; downstream close → `Unsubscribe` ejects the
  publisher; a full FIFO close must wake a blocked writer — FIFO.h already
  notifies `cond_r` on close).
- **Backpressure is the design, not a bug**: a full FIFO blocks the
  converter's synchronous dispatch. The converter's own camera input is
  latest-wins (`Sub::Latest`), so sustained overload sheds frames at the
  camera→convert edge (already metered as converter drops) while
  convert→undistort stays complete and ordered. Document this in the
  ChainedStream header.
- `Threading::FIFO` gains **exact high-water tracking under its existing
  mutex**: `high_water()` (max `queue.size()` ever observed at push) and
  `capacity()` accessors, plus `take_high_water()` (read-and-reset) so the
  reader can maintain a windowed max. Keep the template header-only and
  dependency-free.
- **Metering (single-writer rule preserved)**: the brick's own thread samples
  queue depth around each read and records it into its `ThreadMeter` via a
  new writer API `queueDepth(uint32_t depth, int64_t nowMs)` — per-bin MAX
  over the existing 10s/1s-bin window (same aging as `maxIntervalMs`), plus
  the last-sampled depth and the FIFO capacity. `Meter::Snapshot` gains
  optional queue fields; `meterSnapshotToJs` (ConverterStream.cpp) surfaces
  them as `queue: { depth, highWater, capacity }` — key ABSENT for meters
  that never recorded a depth sample (Leaky bricks unchanged).
- `seqGap` accounting stays. On a FIFO chain it is structurally 0; a nonzero
  value is a bug telltale, so keep reporting it as drops if it ever fires.
- **Topology row**: `appendUndistortReports` (UndistortStream.cpp) marks the
  brick's input edge **`lossy: false`** explicitly (JS fold defaults
  pipe-produced inputs to lossy — the explicit flag must win; extend
  `Topology::addInput` or set the field on the row after).
- Native verification: extend `core/test/22-brick-chain.ts` — under a slow
  fake consumer the undistort output preserves EVERY input frame in order
  (deviceTimestamp sequence complete), probe shows `queue.highWater > 1` and
  zero undistort drops. Rebuild with `cd core && make`. **Do not touch
  app/** — worker F owns the JS half against the schema above.

## §2 High-water mark on FIFO edges (worker F, app/)

Schema (fixed here so E and F run concurrently):

- `WorkloadSnapshot` (app/lib/orchestrator/stats.ts) gains optional
  `queue?: { depth: number; highWater: number; capacity: number }`.
  `native-probes.ts` normalization passes it through defensively.
- `GraphEdge` (app/lib/orchestrator/graph-contract.ts) gains optional
  `queue?: { highWater: number; capacity: number; depth?: number }`.
  `NodeReport` doc comment already promises "FIFO/lossless links omit
  `lossy`" — no shape change needed there beyond honoring explicit
  `lossy: false` from native rows.
- `buildTopologyFromReports` (app/orchestrator/graph-topology.ts): for a
  NON-lossy edge whose CONSUMER snapshot carries `queue`, attach it to the
  edge; `dropPerSec` stays absent (already the non-lossy behavior). Explicit
  `input.lossy === false` must defeat the pipe-producer default (the
  `input.lossy ?? producer?.transport === "pipe"` expression already does —
  add a regression test).
- Profiler (app/src/profiler/graph-view.ts): edge hover detail shows
  `queue` — `hwm N / cap M (10s)` — **in place of** the drops row for FIFO
  edges; the edge warn marker (today `lossy && dropPerSec > 0`) also fires
  when `queue.highWater >= queue.capacity` (backpressure actually engaged).
  Node hover: a node whose snapshot has `queue` shows the same row.
- Tests: graph-topology fold (lossy:false + queue attach) and graph-view
  (hover rows, marker predicate) in the existing test files.

## §3 Controller thread node (worker G, app/orchestrator + sessions)

Current: `Controller` (controller.ts) is a plain class behind the
`activeController()` holder; every session runs its own pull-model
`startActuationLoop` (actuation.ts) at a 1 ms tick; the graph shows a
placeholder node id `"controller"` that PID nodes point edges at;
CMD_FRAME scheduling (scheduler.ts) and trigger pairing math (sync.ts)
exist but nothing composes them.

Ruled: **one long-lived controller NODE object** (`app/orchestrator/
controller-node.ts`), created once at orchestrator startup, binding/unbinding
the active `Controller` as it connects/disconnects.

- **Identity**: node id is the SINGLETON `"controller"` — add
  `nodeId.controller()` to graph-contract and replace both inline
  `CONTROLLER_NODE_ID = "controller"` spellings (disparity-scope session,
  marker-tracker). The serial port is a stat (fold the `controller:<port>`
  serial meter into the node's stats on connect), NOT identity — PID nodes
  register edges at session activate, and the device connects independently;
  a stable id avoids wiring churn. This supersedes the earlier "per-port id
  later" note.
- **Input endpoints — position streams**:
  `node.openPosition(name, { from, initial })` →
  `{ update(pos: {left, right}): {left, right}; close(): Promise<void> }`.
  - Registers graph wiring `from → controller` (port = `name`) on open,
    retires it on close.
  - v2 firmware: each open position input maps 1:1 to an MCU CMD_STREAM
    (create on first update with a live controller, `StreamUpdateGate`-gated
    fire-and-forget updates, terminate on close; recreate on controller
    swap). Free-run DAC-follow semantics are firmware-defined (CREATE
    activates the driving stream) — document, don't fight it.
  - v1 firmware: the node runs ONE internal paced loop (awaited `actuate`)
    over the most recent pushed pose (single-input assumption holds today via
    app exclusivity).
  - `update()` runs `predictVolts` + `mirrorHistory.record` (ONE place for
    the trusted-time trajectory) and returns the predicted volts
    synchronously — sessions use the return for telemetry/homography
    feeders. Optional `onApplied(volts, actuateMs)` covers the v1 awaited
    path.
  - Enable lifecycle absorbed from `startActuationLoop`: enable on first
    open if disabled (tracked `enabledByUs`), disable on last close iff we
    enabled; reconnect drops and lazily recreates streams. The hardware-
    quiescence invariant (janitor, disable-on-disconnect) is untouched — the
    node must never bypass those paths.
  - **`startActuationLoop` is DELETED** once all five call sites migrate:
    disparity-scope, tracking-single, manual-control, calibrate-extrinsic
    (preview), marker-tracker servo. Push model: sessions push at their
    natural cadence (kernel result / pointer / servo tick); the MCU stream
    holds position between updates, and the gate dedupes.
- **Input endpoints — named fovea cameras (trigger mode)**:
  `node.bindFoveaCameras({ left, right })` where each side is a FrameTap
  seam `{ nodeId: string, subscribe(cb(desc: { deviceTimestamp: bigint,
  seq?: number })): () => void }` — INJECTED descriptors, never native
  imports (session/vitest stay core-free). Registers graph inputs
  `camera/<serial> → controller` ports `foveaL`/`foveaR`.
- **Trigger mode + output endpoint**: `node.startTriggerCapture(targets)`
  owns a `RoundRobinFrameScheduler` over the named position streams'
  MCU stream ids; each FIN `FrameOutcome` is matched against the per-side
  recent-frame rings (bounded, ~32 descriptors) by
  `|tExposure − deviceTimestamp| ≤ tolerance` (both trusted host-ns;
  `sync.ts` `matchesExposure` generalizes — the ClockCalibration delta is
  now ≈ trigger-path latency, default tolerance ruled at half the min frame
  interval). Matched pairs emit on `node.onPair(cb({ outcome, left, right,
  stream }))` — the node's graph OUTPUT (`{kind:"analysis",
  schema:"fovea-pair"}`); consumers register their own wiring when they
  subscribe. Pairs carry frame DESCRIPTORS + FIN volt/timestamps this wave —
  pixel payloads keep riding the existing pipes; the live Aravis frame-tap
  wiring and recorder consumption are stage-F work.
- **Node report**: kind "controller", transport "native", owner-less; state
  (connected/enabled/v2Capable/port) in hover stats; report through
  `registerGraphWiring` or a direct `NodeReport` — G's choice, but the
  placeholder synthesis in wiringToReports must no longer be what renders it.
- Tests: node lifecycle against a fake Controller (open/update/close ↔
  stream create/update/terminate, enable ownership, reconnect rebind, v1
  fallback), trigger matching engine with synthetic descriptors/outcomes
  (reuse scheduler.ts + sync.ts test patterns), wiring registration. Migrated
  sessions keep their existing behavior tests green (actuation-stream.test.ts
  is REWRITTEN against the node, same lifecycle assertions).
- **Phasing**: G phase 1 must NOT touch `app/modules/disparity-scope/`
  (a concurrent worker owns it) — build the node, migrate marker-tracker +
  tracking-single + manual-control + calibrate-extrinsic, keep actuation.ts
  alive for disparity-scope. Phase 2 (after the disparity worker lands):
  migrate disparity-scope, delete actuation.ts.
  - SUPERSEDED mid-wave (user ruling): tracking-single was DELETED outright
    (6f8097c — replaced by disparity-scope), so its migration never
    happened; phase 2's migration set became disparity-scope +
    calibrate-distortion (worker H's census caught the latter still
    importing the loop).

## §3.5 Disparity-scope tracker → its own native thread (worker E native half; disparity worker integration half)

Current: `app/modules/disparity-scope/vision.ts` runs a synchronous `KCF`
primitive INSIDE the disparity kernel's worker thread (the "async-kcf
dissolved into the loop" shortcut) — tracking latency rides the matching
budget. Ruled unacceptable per directive 5.

Native half (worker E, core/):

- **Chained KCF brick**: `KcfTrackerStream` today consumes a raw
  `Arv::Stream` (camera frames). Add a CHAINED variant consuming another
  brick's `OwnedFrame` tap (same `ChainedStream` machinery as undistort v2)
  so the tracker tracks EXACTLY what the kernel sees — the undistorted C
  view. Node id `camera/<serial>/undistort/kcf` (extend `nodeId` when the
  JS half lands; native meter name = the id). Input channel: **Leaky**
  (latest-wins is right for a tracker — track the freshest frame, meter
  skips as drops). Perf: reuse the existing single-thread KCF loop; no
  per-frame allocations beyond the result record.
- **Tracker override interface** (both raw + chained variants):
  `override(center: Point2d)` / `releaseOverride()`, callable from JS
  (atomic slot, same discipline as `arm`). While engaged: the tracker does
  NOT update KCF; each frame emits a result with `center` = the override
  value and `overridden: true`. On release: the tracker RE-ARMS (KCF init)
  at the last override center on the next frame, then resumes normal
  results.
- **`TrackResult` gains fields**: `center: Point2d` (bbox center — computed
  once in native, the thing every consumer actually wants) and
  `overridden: boolean`. NAPI serializer + d.ts updated; existing consumers
  (tracking-single) unaffected by the additive fields.
- Native test: extend `core/test/12-kcf-tracker.ts` (or a sibling) —
  override emits flagged results without touching the KCF state; release
  re-arms at the override center.

Integration half (dedicated disparity-scope worker, AFTER its in-flight fix
wave lands + E's API is committed):

- The disparity kernel drops its in-kernel KCF entirely; the session owns a
  chained KCF brick on the C undistort chain and forwards each scalar
  result to the kernel (`setParams`-style target update — thin-coordinator
  compliant: scalars at result rate, never frames).
- The matcher consumes `{center, overridden}` as the target; the projection
  output carries `overridden` through.
- **Drag semantics (RULED — supersedes the PID-override drag path in
  disparity-scope only)**: dragging calls the TRACKER override with the
  wide-view point; the PID vergence node KEEPS RUNNING throughout, steering
  the foveas to converge on the (moving) dragged tile; on release the
  tracker re-arms there and the PID continues seamlessly — the release
  "jump" class dies structurally (no seed reconstruction on this path).
  The PID node's own override slot stays (calibrate apps use it); the scope
  UI simply stops using it for drags. While `overridden` is set the PID may
  clamp/soften rates if needed — worker's judgment, documented.
  - **AMENDED (user ruling 2026-07-08, rig find)**: "the PID keeps
    stepping" could never follow a drag in practice — the guide strip
    recenters on the dragged target, the foveas' actual gaze leaves the
    strip, both match scores fall below `min_score`, and the control law
    HOLDS: the foveas never move. New semantics: while `overridden`, the
    control step is a DIRECT FOLLOW (`followTarget`, vergence.ts) — BOTH
    eyes parallel on the cursor ray with **vergence at infinity** (no PID
    stepping, no match-score gate). REFINED 2026-07-09: pointer-down
    RESETS pan, v_shift AND verge, so the follow rides the RAW cursor ray
    with no residual corrections (drag start may visibly snap if
    corrections had accumulated — intended). The all-zero controller
    state equals the command, so release still resumes the PID
    continuously with no seed (the release-jump class stays dead) and
    every DOF re-converges from scratch. Everything else in this ruling
    (tracker override transport, flag plumbing, re-arm on release, PID
    slot = programmatic only) is unchanged.

**AS SHIPPED (integration half, 2026-07-08 — disparity worker D2):**

- Kernel (`app/modules/disparity-scope/vision.ts`): all KCF machinery gone
  (`trackerInit`/`trackerRelease`/`lostTolerance`/`kernelW/H` params
  deleted); `DisparityParams` gains `overridden?: boolean`, and the kernel
  stamps it onto `projection.overridden` (`scopeProjection(a, overridden)`
  in vergence.ts) — the flag is DATA on the result stream, not topology.
- Session owns `createChainedTracker(cSourcePipeId, nodeId.undistortKcf(
  serialC))` — created on activate right after the C pipe is advertised +
  connected (the chained tap resolves the brick by pipe id), released on
  drain BEFORE the producer retirer runs (DisposerBag FIFO: pipe
  disconnects → tracker release → undistort retire), so the tap never
  outlives its brick. On an uncalibrated wide camera the tracker chains on
  the CONVERT pipe (same fallback the kernel's C input takes).
- Result routing = the pure reducer `tracker-feed.ts`
  (`createDisparityTrackerFeed`): OVERRIDDEN results ALWAYS drive the
  target push (the drag bypasses the armed gate, so drags work with
  auto-follow off); found results are gated by the JS-side `trackerArmed`
  flag (native has no disarm — tracking-single's discipline); lostTolerance
  (10) consecutive misses fire a single lost (gate drops, target holds
  `lastGood` — the old in-kernel policy). Unit-tested with synthetic
  `TrackResult`s (`app/test/disparity-tracker-feed.test.ts`).
- Drag flow as ruled: pointer down/move → `tk.override(p)` + a synchronous
  target/flag push (no one-frame lag); up → `tk.releaseOverride()` (native
  re-arms at the drag end), `trackerArmed = state.tracker_enabled`. The PID
  node's `step` runs on EVERY projection throughout — nothing pins its
  output on this path, no seed on release.
- "Acts correspondingly" while `projection.overridden` — REVISED per the
  2026-07-08/09 amendment above: pointer-down resets pan/verge/v_shift
  and the control step returns the DIRECT-FOLLOW volts (`followTarget`
  of the all-zero state — both eyes parallel on the raw cursor ray,
  vergence at infinity; the pointer handler and `onDrag` also push them
  synchronously so the follow rides pointer/frame rate, not kernel
  rate); the session holds the convergence freeze-window open (a drag is
  user activity) and reports "manual" status. The original "control math
  unchanged / low score holds during a drag" shipping note is what the
  amendment repealed — the match gate no longer applies while dragging.
- The `pidOverride` contract fragment STAYS in disparity-scope as the
  programmatic volts-only path (module-agnostic `usePidOverride` proxy;
  calibrate apps keep their own usage); its seeded release
  (`seedFromOverride` → the pure `seedVergence`) now serves only that path
  and always recovers angles via V2A (the drag's `overrideRay` shortcut
  from the previous wave is gone with the drag itself). The UI override
  badge reads the new telemetry `overridden` (the tracker flag), NOT the
  PID slot.
- Graph: the chained tracker does not self-report topology, so the session
  registers `{ id: nodeId.undistortKcf(serialC), kind: "kcf",
  output: {kind:"track"} }` with edges `C-source → kcf` (frame tap) and
  `kcf → kernel` (port "target", track stream); the tracker's native meter
  is probed out-of-loop under that node id (`registerNativeProbe`).
- `startActuationLoop` NOT migrated here (worker G phase 2 owns the
  disparity migration + actuation.ts deletion, per §4.5).

## §4 Cmd/Ctrl-W closes the window (planner-direct)

`app/electron/main.ts` builds a custom application menu without any Close
item, so the OS-standard Cmd/Ctrl-W is dead. Add `{ role: "close",
accelerator: "CmdOrCtrl+W" }` to the File submenu — routes through the same
`win.close()` flow as the traffic light (welcome respawn rules, owner-close
cascade all unchanged).

## §4.5 Worker ownership map (file-disjoint; planner enforces)

- **Planner (direct)**: main.ts Cmd-W; `graph-contract.ts` + `stats.ts`
  schema fields (ALREADY LANDED with this proposal — workers treat both as
  READ-ONLY); all commits (pathspec).
- **Worker D (in flight)**: `app/modules/disparity-scope/**`, `app/test/`
  (its tests), docs it was told to amend. Nobody else touches these.
- **Worker E**: `core/**` only — §1 FIFO + metering, §3.5 native half
  (chained KCF + override + TrackResult fields), core tests, `make` build.
- **Worker F**: `app/` profiler/topology plumb — `native-probes.ts`,
  `graph-topology.ts`, `graph-view.ts` + their tests. NOT graph-contract.ts
  / stats.ts (planner-owned, already extended).
- **Worker G**: §3 controller node — `app/orchestrator/controller-node.ts`
  (new), `controller.ts`, `actuation.ts` (kept alive until phase 2),
  `marker-tracker.ts`, `scheduler.ts`/`sync.ts` touch-ups,
  `app/modules/{tracking-single,manual-control,calibrate-extrinsic,
  calibrate-drift}/**`, their tests. Phase 1 must NOT touch
  `app/modules/disparity-scope/**`.
- **Disparity worker phase 2 (D2)**: §3.5 integration + §3 disparity
  migration + `startActuationLoop` deletion — dispatched after D and E land.

## §5 Gates + rig items

- Per-slice: `../node_modules/.bin/vue-tsc --noEmit` (app/) exit 0; vitest
  all green. Core slice additionally: `cd core && make` clean build +
  core/test 22 (and touched siblings) pass.
- Wave close: `vite build` (orchestrator bundle stays Vue-free).
- Rig-gated (append to stage-f.md at wave close): FIFO backpressure visible
  live (undistort hwm > 1 under load, zero undistort drops, converter drops
  absorb overload); controller node live edges (pid→controller port rows,
  packets/sec folding); trigger-mode pair matching end-to-end (v2 firmware +
  hardware trigger cabling — center camera stays out, CAM0 uncabled).
