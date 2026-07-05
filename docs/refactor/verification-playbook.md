# Hardware Verification Playbook

> **Status:** Prepared in advance (2026-07-04) — execute when the mechanical
> rig work completes. **Run stages in order; do not skip ahead** — each
> stage's pass is the next stage's precondition, and a failure anywhere is
> attributable only if the stages before it passed.
> **Owner:** Yuxuan runs the rig; findings filed per stage (see "on failure"
> lines) into [`orchestrator.md`](./orchestrator.md) §6 or
> [`synced-capture.md`](./synced-capture.md) §9.
> **Context:** everything landed since the first app run —
> tracking/manual-control migrations, store-hub, RT1 fixes, perf substrate,
> protocol v2, Stage 2 items as they land — is code-verified only (gates +
> 32-test harness). This playbook is where it meets reality.

## Pre-flight (before opening any module)

- [ ] Stage 2 status check: confirm in `orchestrator.md` §7.1 which S-items
      have landed; anything landed since this playbook was written gets
      folded into the matching stage below.
- [ ] `npm install` clean; `cd core && make build` clean (env.cjs handles
      OpenCV/Electron detection); `cd app && npm test` → all green;
      `vue-tsc` 0 errors.
- [ ] **Firmware: do NOT flash v2 yet.** The plugged Teensy runs v1; the
      rebuilt host is v1-compatible via `verifyVersion()` (v2Capable=false
      → resolve-on-ACK). v2 flashing happens only at Stage F.
- [ ] Launch `npm run app` with a terminal visible (orchestrator stderr) and
      DevTools open (diagnostics forward to renderer console).
- [ ] If S4 (profiler window) has landed: open it now, keep it on a second
      display for every stage. If S5 spans landed: note orchestrator boot
      timings on first launch — the first data of the day.

## Stage A — store-hub smoke (widest blast radius, zero cameras needed)

Touches every `Store.open` consumer including renderer-bound calibrate-*.
- [ ] Open manage-cameras (cameras may be disconnected — list can be empty);
      change any persisted setting; restart the app; confirm it stuck.
- [ ] Open a calibrate-* module far enough to confirm config loads (no
      RPC errors in console; UI shows persisted values).
- [ ] Two windows later (Stage E) will retest cross-window store echo.
- On failure: file under orchestrator.md §6 as **RT-S#**; store-hub has a
  dedicated harness suite — reproduce there first if the failure looks
  logical rather than transport.

## Stage B — tracking slice end-to-end (cameras + controller, no capture)

The §5.4 latency win's first live test; also retroactively verifies the
`defineSession`/reactive-client rewrite and the tracking refactor-back.
- [ ] Enter tracking-single: all three previews live; note
      **activate → first frame** time (S5 span if landed; stopwatch if not).
      Expect: several seconds cold (known F3 residual); file the number.
- [ ] Controller connects (title bar); enable; steer via center-view drag —
      mirrors actuate; `volt` telemetry sane (~30 Hz, not 1 kHz).
- [ ] Start tracker on a target: bbox + target overlays aligned with the
      undistorted view; actuation follows; release tracker works.
- [ ] Diff/depth views render; zoom + wrap toggles behave.
- [ ] Leave the module; re-enter within 2 s (RT1-F1 retry window): must
      come back live without "Failed to create camera object" sticking.
- [ ] Idle release: leave the module, wait 10 s, check the orchestrator
      isn't still streaming (terminal quiet; profiler frame rates drop to 0).
- On failure: orchestrator.md §6, **RT-T#**. If actuation hangs: check
  `v2Capable` handling first (synced-capture §9.3 P3.1a) before blaming
  the tracking session.

## Stage C — manual-control end-to-end (incl. capture/recording)

First-ever live run of orchestrator-side capture/record.
- [ ] Display + steering parity with the pre-migration module.
- [ ] Capture: single set-point → preview appears (**V4 replay path** —
      previews are one-shot frames behind late-declared interest);
      save → file on disk correct (16-bit content, not the 8-bit preview);
      discard works.
- [ ] Multi-set-point sweep: indexed previews `capture:<name>#<i>` all
      render; save writes the full set.
- [ ] Recording: start → `.stream`/`.meta`/manifest appear and grow; stop →
      decodable (`stream-decoder.py`). If S3 (recorder worker) landed:
      compare `loopLag` during recording vs idle — the S3 acceptance
      number; file it in orchestrator.md §7.3.
- [ ] **Leave the module mid-capture and mid-recording** (V1 fix): no
      orchestrator crash, no stuck camera; re-enter works; partial
      recording file is closed/valid.
- On failure: orchestrator.md §6, **RT-M#**.

## Stage D — module-switching torture (RT1 closure)

- [ ] Cycle: tracking → calibrate-* → tracking → manual-control →
      manage-cameras → single-capture, ~5 s dwell, two full loops. No
      dead sessions, no camera-connect warnings that stick, no leaked
      streams (profiler/terminal quiet between modules).
- [ ] Repeat once with fast (<1 s) switches: F1's retry window should
      absorb everything; note worst recovery time.
- On failure: orchestrator.md §6 under the RT1 heading — include the exact
  module sequence; this is the seam with the most history.

## Stage E — multi-window + perf baseline (the archive artifact)

- [ ] Open a second window (S4 profiler if landed, else a second main
      window): same camera preview in both = registry fan-out live; C10:
      topics only one window views should show `sent` only to it
      (profiler channel stats).
- [ ] Store echo: change a camera setting in one window; other window's
      manage-cameras reflects it (store-hub broadcast).
- [ ] **Perf baseline (§7.3 item 5), archive all three snapshots:**
      1. tracking locked on target, 60 s, windows idle → `perfSnapshot`;
      2. same + continuous main-window resize/devtools → snapshot
         (orchestrator `loopLag` must stay flat — the §1 claim);
      3. two windows on one camera → snapshot (copy-cost datum for the
         shm-ring gate).
      Store snapshots under `docs/refactor/baselines/<date>/` and commit.
- On failure: orchestrator.md §6, **RT-W#**.

## Stage F — firmware bench (synced-capture §4; needs scope/logic analyzer)

Still on v1 firmware? No — this stage begins the v2 path: bench the Teensy
**disconnected from the app** first.
- [ ] Flash v2 firmware to the bench Teensy.
- [ ] Run `core/test/02-serial-protocol.ts` (now v2-aware: verifyVersion,
      stream CREATE + seq-0 UPDATEs, accepted-vs-completed latencies) —
      record its stats block, including serial throughput via
      `Device.stats` during the 1 kHz UPDATE phase (USB CDC headroom
      check — the "baud" is nominal, this is the real number).
- [ ] **64-stream flood (ST-64):** create 64 streams; UPDATE all at 1 kHz
      for 30 s — no REJ storms, no intake stall (validates ST-64b
      chunk-drain), DAC still tracks the active stream smoothly,
      `Device.stats` rate ≈ the predicted ~1.5 MB/s; terminate all 64
      cleanly. Archive the numbers next to the baseline snapshots.
- [ ] **Activation semantics:** enable → CREATE stream 0 → seq-0 UPDATEs
      move the DAC immediately, with **no frame request in flight**
      (auto-activate-on-first-CREATE, synced-capture §3.2); TERMINATE →
      mirrors freeze at last target.
- [ ] Scope checklist (synced-capture §4): ACK precedes trigger; mirror
      UPDATE visibly moves the DAC mid-strobe; FIN timestamps vs scope
      trace; duplicate-stream REJ; cross-stream queue order; dead-camera
      timeout REJ (FW2 check: mask a camera's strobe line); calibrate
      `STROBE_MARGIN_US` from the real trace and commit the value.
- [ ] If the §9.7 FIN-delivery symptom recurs in any form: re-run with the
      serial lifecycle trace at full level (§9.7.2) and archive the log —
      it is designed to make one failing request self-diagnosing
      (`grep seq=N` gives the full tx→rx→task→resolve lifeline).
- On failure: synced-capture.md §9, **FW#** — firmware fixes re-enter at
  P2.1 severity.

## Stage G — v2 live integration (P4 hardware wiring)

- [ ] With v2 flashed and the app rebuilt: `verifyVersion` → v2Capable=true
      in the controller session telemetry.
- [ ] `enableHardwareTrigger` on L/R with the real GenICam line names
      (verify `LineSelector`/`LineSource=ExposureActive` naming against the
      FLIR's actual feature tree — the plan guessed defaults).
- [ ] Clock calibration (`sync.ts`): run after every enable; deltas stable
      across repeated runs (< half frame interval drift).
- [ ] Matched L/R pairs flowing; center free-runs; pair timestamps
      monotonic; mirror-position telemetry matches FIN latches.
- [ ] Profiler stream probes: one row per live stream showing UPDATE Hz +
      XY position pads tracking the commanded motion in real time; serial
      data rate steady under load (no sawtooth = no backpressure stalls).
- On failure: synced-capture.md §9, **P4-#**.

## Stage H — P5 integration + exit criteria

- [ ] tracking-single on one hardware-synced stream end-to-end.
- [ ] Re-run the Stage E baseline scenario on the synced path; archive.
- **Exit criteria for the whole playbook:** all stages green, baselines
  committed, every filed finding either fixed or explicitly deferred with
  an owner. At that point: update both docs' status headers, and the
  shm-ring / multi-window / calibrate-* items in orchestrator.md §7.2
  become schedulable on real data.
