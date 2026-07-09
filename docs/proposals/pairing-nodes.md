# Pairing nodes — per-stage L/R pairs anchored on exposure completions

Status: **RULED — in execution** (user 2026-07-09). Companion to
[multi-fovea-recording](./multi-fovea-recording.md) (its descriptor channels
become this design's first consumer).

## Intent (user ruling)

L and R fovea frames flow through per-side preprocessing stages (convert,
undistort) on independent brick threads — that parallelism is preserved,
never merged into one thread. The intermediate result of EACH stage must be
accessible as an L/R **pair**. A **pairing node per stage** joins the two
sides, anchored on the controller's completed exposure requests (FIN), with
V2A (volts→angle) and H attached to the anchor by a separate middle node.
Pairing nodes are **always running** (unlike on-demand composed nodes),
maintain an active pool of anchor points, and drop unused pairs when no
consumer subscribes — cheap by construction (manipulating three shared
references per pair, never pixels).

## Rulings

1. **Trigger mode ONLY** (user 2026-07-09): anchors are real FIN outcomes;
   the pool exists only while trigger capture runs. In free-run the pairing
   nodes idle with an empty pool — NO synthetic timestamp-proximity anchors,
   ever. A pair record always carries its anchor, so provenance is explicit.
2. **Tolerance-match ONCE, at the root; exact-key joins downstream.** The
   ±tolerance window (`matchPair` semantics: |deviceTimestamp + delta −
   tExposure| ≤ tol, default half min frame interval) runs only where raw
   camera arrivals meet the FIN. Every brick passes `deviceTimestamp`
   through unchanged (established meta-passthrough contract), so downstream
   stage pairs join by EXACT key equality on the carried timestamp — no
   re-matching, no compounding windows.
3. **PairStream native brick** (the per-stage join): two **in-process FIFO
   TapChannel inputs** (`OwnedFrame::Ptr` — the unified-time §5 tap
   transport; SHM rings are for IPC/JS-worker boundaries ONLY, ruled
   2026-07-09) on its own thread; anchors pushed in via NAPI at FIN rate
   (the `pushHomography` pattern); a pair record PINS
   `{anchor, OwnedFrame::Ptr left, OwnedFrame::Ptr right}` — three shared
   references, no pixel copies, no ring-recycling hazard. Memory is bounded
   by the pair/anchor pool (drop-oldest releases the buffers), NOT
   ringDepth. Output surfaces: a batched async iterator for JS consumers
   (MultiKcfStream pattern — zero per-frame JS work; descriptors for
   RECORDING re-key onto recorded-stream seqs via deviceTimestamp, which
   the raw12p tap stamps identically to the Frame path) + the standard
   brick meter block. One brick class, two join modes: `root` (toleranceNs)
   and `exact` (key equality).
4. **Anchor enrichment middle node** (JS, FIN-rate — low, loop-safe): FIN
   outcome → `{tExposure, stream, volts, V2A angles, H}` using the V2A
   calibration + `mirror-history`/`conversionComputeH`, then `pushAnchor`
   to every registered pairing brick. ONE anchor pool source feeds all
   stages (the anchor is stage-independent); pool bounded, drop-oldest.
5. **Always-running lifecycle**: pairing bricks + the enrichment node start
   with the session's trigger topology and stop with it — not composed
   on-demand, exempt from consumer-refcount teardown, but they die with the
   session like every brick (no hardware arming → no quiescence-invariant
   interaction). With zero subscribers the brick still consumes inputs and
   maintains the pool, dropping completed pairs immediately.
6. **Supersedes the controller node's in-JS pair matching**: `matchAndEmit`
   + `DescriptorRing` + `onPair` (controller-node.ts) migrate INTO the root
   PairStream — the controller node keeps scheduling CMD_FRAME and emitting
   FIN outcomes but stops doing per-frame descriptor bookkeeping in JS.
   `sync.ts` `matchPair`/`matchesExposure` stay as the ruled arithmetic
   (ported to the brick; unit tests keep the pure JS reference).
7. **Graph**: topology rows `pair/<stage>` (kind "pair", open styling set)
   with edges `<stage>-L → pair`, `<stage>-R → pair`, `controller → pair`
   (port `anchor`). The enrichment node rows as `controller/anchors`.
8. **Known consumer fixes to follow** (each its own ruling when reached):
   recorder descriptor channels consume pair records (wave I-2 of
   multi-fovea-recording — pair ⋈ target bbox); StereoStream/SGBM currently
   joins latest-L/latest-R with no anchor (temporal misalignment under
   motion) — migrating it onto paired inputs is a follow-up ruling.

## Execution

Slots into the multi-fovea-recording wave order (serialized core builds):
I-1c (ring v5 + compression, in flight) → **P-1** (this proposal: PairStream
brick + enrichment node + controller migration + graph rows; core test +
vitest) → R-1 (review over I-1a/b/c + P-1) → I-2 (session wiring, descriptor
channels consume pair records) → R-2 (close). Rig items (real FIN pairing,
tolerance tuning, always-on pool behavior under live churn) accumulate in
`docs/hardware/stage-f.md` §"Pairing nodes".
