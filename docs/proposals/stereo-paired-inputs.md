# Stereo paired inputs — SGBM over exposure pairs

Status: **SHIPPED (code-complete 2026-07-09, `5537745`; rig pass owed —
`hardware/stage-f.md` §"Stereo paired inputs")**. Ruled by the user
2026-07-09 ("dispatch them all" over the planner's presented design). Closes
`pairing-nodes.md` ruling 8's open item: StereoStream was the last
unanchored two-input join in the graph. See **AS SHIPPED** at the end.

::: details Problem: latest-L/latest-R join mixes epochs under motion

`StereoStream` joins latest-L/latest-R: it ticks on every left arrival and
pairs it with the newest right frame seen so far (no cross-camera key — the
two sides are paced by different owner clocks). Under motion the two frames
can be one-plus frames apart, so the disparity map mixes epochs — exactly the
temporal misalignment the pairing nodes were built to eliminate.
:::

## Design (ruled)

1. **A paired-input variant of the stereo join, not a rewrite.** The SGBM
   compute path (`process(left, right)`, reactive params, F32 output in
   left-frame coordinates, meters) is unchanged; only the input side is
   replaced. `PairStream` is itself a `Stream<PairBatch::Ptr>`, so the paired
   variant chains on the pair brick with ONE tap (FIFO — records are cheap
   and already bounded upstream) and runs SGBM per pair record: matched L/R
   by construction, anchor provenance carried on the record.
2. **Trigger-only, like all pairing.** When the session's trigger topology is
   live, the stereo node is composed in paired mode over the appropriate
   stage pair (`pair/undistort` for the SGBM center view); in free-run it
   composes the existing latest-wins brick. Mode selection is a session
   RECOMPOSE on trigger start/stop — node churn semantics are already proven
   (C-20 compose acceptance test) — never an in-brick runtime switch.
3. **Rejected: anchor-matching inside StereoStream.** That would duplicate
   the pair pool and violate the tolerance-once ruling (`pairing-nodes.md`
   ruling 2). The stereo brick consumes pairs; it never matches.
4. **Consumers unchanged.** The disparity pipe advert (`Disparity32F`, F32,
   left-sized) is identical in both modes; the heatmap brick chains on the
   pipe as today. Output timestamps remain the LEFT frame's (trusted-time:
   forwarded, never re-stamped).
5. **Downstream demand still gates.** The paired stereo brick stays
   on-demand (ChainedStream contract) — parked, it consumes nothing; the
   pair brick's always-running keep-alive is unaffected (it drops completed
   pairs when the stereo consumer is parked).

## Execution

One worker wave: core brick variant (reuse `StereoStream`'s compute; new
pair-tap input path) + seam arg (`stereo-pipe.ts` paired attach) + session
recompose on trigger start/stop + `core/test/34-stereo-paired.ts` (synthetic
pair source → per-record SGBM ticks, mode parity, park/resume). Rig items
land in `hardware/stage-f.md` §"Stereo paired inputs" at wave close (SGBM
epoch-mixing gone under motion; recompose on trigger toggle is seamless).

## AS SHIPPED (2026-07-09, `5537745`)

- **`StereoStream` paired mode is construction-time** (`createPaired(pairSource,
  pairFrom, …)`): `start/stop/iterate` branch on `paired_`; the paired path
  adds a `RecordSink` (a `Subscriber<PairBatch::Ptr>` on the pair brick)
  feeding a bounded `RecordChannel` the SGBM thread drains, calling the
  UNCHANGED `process(left, right)`. NAPI `attachStereoPaired(pairStage,
  pipeId, params)`; topology reports ONE input edge `pair/<stage>` →
  `stereo/<name>` (port `pair`); `stereoProbeAll` gains `paired` +
  `pairDrops`.
- **Delta from ruling 1 ("ONE FIFO tap"): the record tap is bounded
  DROP-OLDEST (cap 8), not a blocking FIFO.** A blocking FIFO would let a
  slow SGBM backpressure the always-running pair brick's dispatch (stalling
  root anchor forwarding — violating ruling 5). Drops are metered
  (`pairDrops`) — correct semantics for an on-demand live disparity view.
- **Composition lives in multi-fovea, not disparity-scope**: the trigger
  topology, FIN anchors, and `pair/undistort` stage exist only there — the
  session composes `stereo/paired` with the pairing topology (on-demand,
  seam-degrading); disparity-scope's free-run latest-wins node is unchanged
  (ruling 2's free-run half).
- **Recompose granularity = topology up/down.** A WITHIN-activation live
  flip between latest-wins and paired awaits hardware trigger wiring
  (`startTriggerCapture` is not yet driven by any live session — stage-f
  gated); both compositions + the seam exist, so the flip is wiring, not
  design.
- **`PairStream` production surface unchanged** — the only touch is the
  test-only `pushPairTestFrame` deterministic `texture`/`shift` fill (the
  cross-mode SGBM parity oracle in test 34: bit-identical maxΔ=0 on a
  static pair, median tracks the injected 16 px shift).

### Final gates

Core make clean; `core/test/10,11,26–34` all exit 0 (from repo root);
`vue-tsc --noEmit` 0; vitest 535/535; soak 4/4; `vite build` clean
(orchestrator 292.94 kB). No Electron.
