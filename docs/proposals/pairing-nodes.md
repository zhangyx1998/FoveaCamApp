# Pairing nodes — per-stage L/R pairs anchored on exposure completions

Status: **SHIPPED (code-complete; rig pass owed)** — 2026-07-09, through the
R-2 close. Ruled by the user 2026-07-09. Companion to
[multi-fovea-recording](./multi-fovea-recording.md) (its descriptor channels
are this design's first consumer — the shipped L/R descriptor pointers come
from these pair records). Live-rig verification accumulates in
`docs/hardware/stage-f.md` §"Pairing nodes". See **AS SHIPPED** at the end.

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

## AS SHIPPED (2026-07-09, R-2 close)

### Commit chain

- **P-1** `426eb05` — the `PairStream` native brick (one class, two join
  modes: `root` tolerance-match + `exact` key-equality; two in-process FIFO
  `TapChannel` inputs on its own thread; batched async-iterator output, the
  MultiKcf pattern) + the anchor **enrichment node** (`anchor-node.ts` —
  FIN outcome → opaque `Float64Array` payload of `{volts, V2A angles, H_L,
  H_R}`, fanned to every registered brick) + the controller-node migration
  (in-JS `matchAndEmit`/`DescriptorRing`/`onPair` removed; `sync.ts`
  `matchPair`/`matchesExposure` kept as the ported pure-JS reference) +
  graph rows (`pair/<stage>`, `controller/anchors`).
- **R-1** `ac6ee85` — resolved-anchor **key delivery** for the downstream
  `exact` stage: P-1 deferred "how downstream frames land identical keys";
  R-1 rules it with RESOLVED anchors (`resolvedAnchorFromRecord` — the root
  record's two matched deviceTimestamps ARE the next stage's join keys, never
  re-stamped → trusted-time preserved).
- **I-2b** `c015a01` — the session **wiring** (`multi-fovea/session.ts`):
  root pair over the L/R convert taps + downstream exact pair over the
  homography-undistort outputs, both always-running with the trigger topology;
  `controllerNode().onFin → anchorNode.ingest → pushAnchor`; the session
  consumes root records → `pushResolvedAnchor` downstream + `onPairRecord`
  into the recording controller.
- **R-2** (this wave) — review + this close. All gates green.

### Deltas from the ruled design

- **Resolved-anchor mechanism** (R-1, above) concretizes ruling 2's
  "exact-key joins downstream": the root is the ONLY tolerance-match; the
  downstream `exact` brick receives keys, never re-windows.
- **Merge-FIFO / keep-alive**: the always-running brick (ruling 5) is wired
  via a **keep-alive subscriber** — the session's `consumePairs` iterator
  drains the root's batched records at FIN rate even when no other consumer
  subscribes, so the pool churns (drop-completed) and the resolved-anchor +
  descriptor fan-out always runs.
- **Degrade path**: a missing source brick (converters not live on a rig
  shape) is caught and logged (`console.warn("[multi-fovea] pairing wiring
  unavailable")`) → recording degrades to unpaired (descriptors without pair
  provenance), never fails activation. Root release is deferred BEFORE the
  downstream attempt, so a downstream throw leaks nothing.

### Residuals (rig / follow-on rulings)

- **StereoStream/SGBM latest-L/latest-R → paired inputs** — RESOLVED
  2026-07-09: ruled + shipped as `stereo-paired-inputs.md` (`5537745`);
  the paired-SGBM node consumes pair records over `pair/undistort`.
- **Anchor edge `frameType`** — the `controller → controller/anchors` edge
  is typed `analysis/pid` (scalars, no frame); a dedicated FIN edge type is
  cosmetic, deferred.
- **GenICam trigger-line names** in `sync.ts` are UNVERIFIED placeholders —
  confirm against the real camera model (stage-f).
- **Tolerance tuning** (`toleranceNs` default = half min frame interval) +
  always-on pool behavior under live churn: rig items, `docs/hardware/stage-f.md`
  §"Pairing nodes".

### Final gates (R-2)

Shared with multi-fovea-recording's R-2 close: `cd core && make` → 0;
`core/test/28..33` → all exit 0; `vue-tsc --noEmit` → 0; `vitest run` →
531/531; soaks 4/4 TWICE; `vite build` → 0. Core test 33 (`33-pair-pipe.ts`)
covers the brick. No Electron.
