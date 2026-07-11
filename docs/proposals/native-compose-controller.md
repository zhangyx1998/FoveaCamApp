# Native compose + controller in-port — phase 2 of the port-pipe program

Status: **SHIPPED (2026-07-11; rig pass owed — see AS SHIPPED below).**
Phase 1 (the port/pipe substrate) shipped in
[`native-port-pipe.md`](./native-port-pipe.md).

## AS SHIPPED (2026-07-11)

Landed as planned: `ComposeStream` brick (Jacobian rebase from JS at pid
rate, floor emit on rebase AND tick), controller `MirrorSink` pos_in
(native 1 ms gate with exact `StreamUpdateGate` parity, byte-identical
CMD_STREAM UPDATE framing verified over a pty, 4096-sample native history
ring with `mirrorAt`-parity interpolation), `SerialWriteSeam` (one write
mutex shared by Device + sinks; seam closes before the fd on disconnect —
the FW5 invariant), disparity-scope fully rewired
(`imm.predict_out → compose.pred_in → controller pos_in`), JS compose node
reduced to the pure conformance reference + shared fixture vectors
(`docs/schema/codec/compose-vectors.json`).

Deltas: (1) the JS posInput path survives as an explicit FALLBACK (v1
firmware / no controller — JS is then a genuine consumer; zero JS per tick
on a v2 rig); (2) `InPort.__payload` brand made INVARIANT (function-typed) —
`ImmPrediction` structurally supersets `TrackResult`, so a covariant brand
compiled a pipe the runtime tags reject; (3) interpolating `historyAt`
added; (4) the compose→controller edge exists only while a sink is attached
(truthful). mirrorHistory audit: every consumer preserved; pre-existing
finding logged — multi-fovea never writes mirror history (its
"history-interpolated" recording extras already read an empty ring).

**Teardown-race fix (planner-verified 30/30+10/10+10/10 clean-exit loops):**
an abnormal exit (uncaught exception) skips env teardown, so native Cleanup
hooks ran from libc static destructors and hit unspecified inter-TU
destruction order (use-after-free SIGSEGV). Fix in `core/include/Cleanup.h`:
the hook registry is INTENTIONALLY LEAKED — hooks run only via live-env
teardown/`core.cleanup()`; crash-shaped exits run no native hooks (janitor
owns hardware quiescence there BY DESIGN) and now die with their true exit
code instead of masking it with SIGSEGV.

RIG-GATED (bench session): wave-1 behavior parity (feed-forward lead, drag
pass-through, lost hold, exact-vs-linearized delta on a fast target);
profiler edges from link rows at ~600 Hz, compose→controller edge vanishing
when unplugged; FW5/quiesce ordering on the serial line incl. unplug/replug
mid-tracking; recorder volt-provenance + viewer footprints from the native
ring; v1-firmware fallback drives mirrors; crash-shaped exit → true exit
code + janitor sweep disables mirrors (native exit hooks no longer exist).

## Goal

Eliminate the two remaining JS hops on the high-rate control path:

```
BEFORE:  imm ──(600 Hz async iterator)──→ compose(JS) ──(posInput.update NAPI)──→ controller(JS) → Device
AFTER:   imm ══pipe══→ compose(native) ══pipe══→ controller pos_in(native) → Device
                ↑ rebase(params) at ~60 Hz (JS pid — stays JS, camera-rate)
```

The JS orchestrator loop stops seeing per-tick work entirely; it feeds
low-rate parameters, exactly like the volts→H homography-feeder precedent.

## Planner decisions (veto points — flagged for the user)

1. **Compose math goes to the ruled Jacobian form.** The ruling was
   `V = V_pid + J·(p_pred − p_meas)`; wave 1 implemented `J·Δp` as the exact
   follow-difference (`follow(p_pred) − follow(p_meas)` in JS). Natively, JS
   pushes the linearization at each pid rebase: `{ V_pid, p_meas, J_l, J_r }`
   with `J` = per-eye 2×2 finite-difference of `followVolts` around
   `p_meas`. First-order in the intra-frame delta — semantically the ruled
   formula verbatim; the exact-vs-linearized delta is a rig item.
2. **The controller gains a native position in-port**, not a native
   controller: `pos_in` accepts FINAL volts (compose emits final values), so
   the sink only needs the stream-update gate (1 ms min interval + dedupe,
   replicated natively), the MirrorStream UPDATE fire-and-forget write (the
   packet path is already native `Device`), and history recording. All JS
   `predictVolts`/pose logic stays JS for JS-driven inputs.
3. **Mirror-history provenance moves to a native ring for natively-driven
   inputs.** A fixed-size `{tNs, l, r}` ring recorded at the native write,
   with NAPI range/latest queries. JS `mirrorHistory` remains the authority
   for JS-driven position inputs (manual-control pacer, drag); consumers
   that need disparity-scope trajectory (recorder volt-provenance, footprint
   extras) query the native ring through a session-provided accessor. The
   worker must AUDIT every `mirrorHistory` consumer and report any that
   cannot be preserved this way — report, don't break.
4. **Baseline floor moves into the native compose**: it emits on BOTH
   `rebase()` (~60 Hz — mirrors always driven, brick cold or warm) and each
   prediction tick (~600 Hz). The wave-1 JS `pushVolts` floor for
   disparity-scope is retired with the JS compose node; override/lost
   semantics ride a `feedForward: boolean` on the rebase (false → ticks hold
   the baseline, exactly the wave-1 `predVolts = null` behavior).

## Design

- **`ComposeStream` brick** (core): in-port `pred_in` (imm predictions via
  pipe), out-port `volt_out`; standard `Stream` thread polling the in
  channel; NAPI `rebase({vPid, pMeas, jL, jR, feedForward})`, ThreadMeter
  (in `pred`/`rebase`, out `volt`).
- **Controller `pos_in` sink** (core, Controller/Serial domain): typed
  in-port; native gate + UPDATE write on the link delivery thread; native
  history ring + `historyQuery(fromNs, toNs)` / `historyLatest()` NAPI.
  Binding/unbinding follows the JS controller-node bind lifecycle (a session
  can only pipe into it while a controller is bound; unbind releases links).
- **Disparity-scope rewiring**: `imm.predict_out.pipe(compose.pred_in)`
  (latest) and `compose.volt_out.pipe(controller.pos_in)` (latest); the pid
  step calls `compose.rebase(...)` (NAPI, 60 Hz); JS
  `app/orchestrator/compose-node.ts` is retired (it was disparity-scope
  only); volt telemetry reads `historyLatest()` at the existing throttle
  instead of per-push callbacks.
- **Unchanged**: every other session's JS `posInput` path; pid math/timing;
  imm brick; prediction-rate config plumbing; FW5 (no awaited Actuate while
  a stream is active) and the quiesce order (MEMS disable before camera
  release) must hold identically — the native sink must terminate its
  stream on unbind/teardown exactly as the JS input does.

## Safety invariants (binding)

- FW5 and the stream-teardown discipline are non-negotiable: the native
  sink's stream terminate/park path must be exercised by the numbered test,
  including release-under-load and controller disconnect mid-flow.
- The quiesce path (`quiesceHardware`) must still find and stop the native
  stream — audit `controller-node`'s disable path and wire the native sink
  into it.

## Verification (software; this machine is rig-less)

- New numbered test (`45-native-compose`): rebase+tick math conformance
  against the wave-1 JS `composeVolts` on shared vectors (incl. feed-forward
  off, baseline holds, rebase-mid-stream); gate dedupe/min-interval; history
  ring recording + queries; teardown under load; FW5-adjacent stream
  terminate on unbind. Fake-serial Device (existing serial test precedents).
- `42/44` stay green (imm + pipe substrate unchanged); vitest session tests
  updated with the new seams faked; vue-tsc + boundary greps; d.ts
  hand-updated (ComposeStream, pos_in, history queries, port properties).
- RIG-GATED: behavior parity with wave 1 (feed-forward lead, drag
  pass-through, lost hold), exact-vs-linearized compose delta on a real
  target, recorder volt-provenance + viewer footprints fed from the native
  ring, quiesce leaves mirrors parked.
