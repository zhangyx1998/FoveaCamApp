# Planner triage (2026-07-07)

## WAVE-1 LANDED + PLANNER-VERIFIED (2026-07-07, accepted)
- **A (A-15):** A-P2 (tracking-single display vision → named frame
  workers `tracking:center`/`tracking:fovea:{L,R}` with idle cancel),
  A-P3 (Vue-free `fovea-pipeline` primitives, adopted tracking/manual/
  disparity), A-P5 (`useFrames`/`useDynamicFrame`, 5 call sites), A-P9
  (app-registry consistency test, explicit loader map kept), A-P14
  (approved renames only; vetoes untouched).
- **B (B-8):** B-P2 (12p vectors in `docs/schema/codec/` + `Codec/
  Packed12.h`, consumed C++/TS/pyfovea), B-P3 (schema-as-code
  `docs/schema/fovea.ts` + mirrored `pyfovea.schema`, writer/converter/
  bench on real names), B-P7 (chunked host serial RX, byte trace behind
  VERBOSE), **B-P8+B-P9 (firmware PendingAction helper + fixed Ring
  queue — post-edit `pio run` SUCCESS, planner-verified: FLASH 89 420 B,
  the compile gate B set as its DoD).**
- **C (C-10):** C-P3 (shared `@lib/orchestrator/stats` window/rate
  bookkeeping), C-P5 (`readSnapshot()` + deprecated `view()` alias),
  C-P8 (process-local topic-key collision registry that THROWS +
  costarring/liquid test), C-P10 (approved renames + aliases; vetoes
  kept), C-P1 (`frame-payload` normalizer adopted at all 5 meta-merge
  sites + precedence test).
- **Planner sweep (authoritative, unsandboxed):** vitest **174/174**
  (the 173/174 both A and C reported was mid-flight concurrent-codec
  timing — `codec-fixtures.test.ts` passes clean now), vue-tsc 0,
  `08-shm-ring.ts` shm smoke PASS (C's sandbox couldn't run it), pyfovea
  28/28, `core make build` both runtimes, firmware `pio run` SUCCESS,
  vite build + V11 triplet (0/0/0 on both preloads). Committed as the
  wave-1 checkpoint.


## GREEN-LIT (non-breaking; planner authority) — dispatched in waves
- A: P2, P3, P4, P5, P8, P9, P10, P11, P13, P14 (P14 minus two vetoed
  renames: keep `activeSubscribers`, keep `telemetrySnapshot` — load-
  bearing precision in runtime core).
- B: P1 (generator stays trivial; artifacts checked in), P2, P3, P4,
  P7 (byte-level trace preserved behind verbosity), P10 (additive
  `iter_frames_streaming` only). P8/P9 conditional: only with a
  passing local firmware compile; else deferred to bench era.
- C: P1, P2 (buffer-ownership tests pinned: success/null/timeout/stale),
  P3, P4 (shared TU must stay libc-only), P5 (alias phase only),
  P7, P8 (choose the process-local collision registry that THROWS),
  P9, P10 (minus vetoes: keep `latestBefore` — the proposed name is
  longer; drop `workloadSnapshot→snapshotWorkload` churn), P11
  (ratified as documented dedupe semantics — matches one-window-per-
  file product rule; planner arbitrates the contract note).
- CROSS-ROLE CODEC ITEM (merged B-P1+B-P2+B-P3+C-P6): one conformance
  fixture set + shared format tables; B owns format facts and the
  fixture, C owns the TS decode conformance side. Tests-first, then
  registry.

## PLANNER-DEFERRED (with reasons; revisit at the named trigger)
- A-P6 (StreamView/FrameView split) — after the user's Stage 5 GUI
  smoke (UI regressions need a live baseline first).
- B-P6 (request FSM) — MUST NOT precede the P4.1 bench: the diagnosis
  needs the code that produced the symptom.
- B-P14 (protocol renames) — post-bench (trace-history legibility).
- B-P11 (native worker pool) — needs multi-fovea live load numbers.
- B-P5 (protocol codegen) — DECLINED for now: L-effort/high-risk
  codegen on a hardware-gated surface right before bench; B-P2-style
  spot tests guard the drift more cheaply until v2 stabilizes.
- C-P12 (explicit byteLength/dtype in FramePayload) — recorded as a
  HARD GATE on any future raw/16-bit/12p shm transport dispatch; no
  code now.

## USER DECISIONS (breaking-but-better; planner recommendation attached)
1. A-P1 resource-scoped session lifecycle — RECOMMEND YES, scheduled
   AFTER the Stage 5 GUI smoke (it rewires every hardware session's
   activation; the bug class it kills produced V1/V5/V10/RT1/PB3).
2. A-P7 contract camelCase normalization — RECOMMEND YES, soon
   (call-site count only grows); needs a persisted-key audit first.
3. A-P12 explicit frame address (kill the meta.source mutation) —
   RECOMMEND YES, bundled with A-P7 (same call-site sweep).
4. B-P12 recorder full-res sharding — THIS IS the pending full-res
   tier question, now with an implementation sketch. Decide the tier;
   sharding follows or stays shelved.
5. B-P13 capability negotiation (vs major-version math) — RECOMMEND
   YES bundled with the v2 flash at Stage F (needs firmware
   coordination anyway).

## USER DECISIONS TAKEN (2026-07-07 — "all recommendations accepted")
1. A-P1 lifecycle unification: APPROVED — scheduled AFTER the Stage 5
   GUI smoke (wall item gates it).
2. A-P7 camelCase normalization: APPROVED — next optimization wave
   after wave 2, preceded by a persisted-key audit.
3. A-P12 explicit frame address: APPROVED — bundled with A-P7.
4. B-P12 sharding: per recommendation, SHELVED — current 1.5 MiB tier
   suffices; sharding revives if/when full-res raw recording becomes a
   requirement (the topology seam keeps it additive).
5. B-P13 capability negotiation: APPROVED — bundled with the v2 flash
   at Stage F.
