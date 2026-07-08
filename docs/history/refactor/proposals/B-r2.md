# Coder B Optimization Survey — Round 2 (B-10)

Re-survey after wave 2 (B-P1 `PIXEL_FORMATS` single source, B-P4 production-
writer bench, B-P10 streaming pyfovea). Surfaces: `core/**` (minus C's
ShmRing/reader), `lib/Protocol/**` (B's host+MCU protocol surface),
`firmware/**`, `pyfovea/**`, `app/orchestrator/recorder/**`,
`playground/bench-recorder/**`, `docs/schema/**`.

Ranked by value. **Not re-proposed** (deferred/declined — referenced where
adjacent): B-P5 (codegen, declined), B-P6 (request FSM, post-bench), B-P11
(worker pool, live load), B-P12 (sharding, shelved), B-P13 (capability
negotiation, Stage F), B-P14 (protocol renames, post-bench).

The through-line: B-P1 proved the **checked-in trivial-generator + X-macro**
single-source pattern is cheap and non-breaking. Several residual hand-kept
lists it did not reach are the same shape and want the same treatment.

## B-R2-P1 — Protocol Method/Property enum↔string via the B-P1 X-macro pattern

- **Locations:** `lib/Protocol/Protocol.h` (`Method`/`Property` enums),
  `lib/Protocol/Protocol.cpp` (four hand-written switches: Method→string,
  string→Method, Property→string, string→Property).
- **Current → proposed:** The `Property` list (13 members) and `Method` list
  (7 members) are each spelled out in the enum plus twice more as
  forward/backward string switches in `Protocol.cpp` → one X-macro table per
  enum (e.g. `FOVEA_PROTOCOL_PROPERTIES(X)` / `_METHODS(X)`) that the enum, both
  string directions, and any future JS mirror expand — exactly the
  `FOVEA_PIXEL_FORMATS` shape B-P1 landed. Generator can stay a hand-written
  X-macro header (no emitter even needed; the table IS the header).
- **Category:** non-breaking.
- **Rationale:** This is the single clearest "the registry pattern reaches
  another enum" win the coordinator asked about. The Method/Property facts live
  in 3 places each (5 for Property once you count `Controller.cpp` `Init`
  registration); adding a protocol property today means editing the enum + two
  switches by hand — the exact drift class B-P1 removed. **Bonus:**
  `lib/Protocol` is shared (PlatformIO copies it), so this fixes host AND MCU
  in one edit — no firmware-specific duplicate exists to chase.
- **Effort:** S. **Risk:** Low (emitted strings byte-identical; covered by
  `02-serial-protocol.ts`).

## B-R2-P2 — Generate `pyfovea/schema.py` from `docs/schema/fovea.ts`

- **Locations:** `docs/schema/fovea.ts`, `pyfovea/src/pyfovea/schema.py`,
  `docs/schema/generate-pixel-formats.ts`.
- **Current → proposed:** `schema.py` is a **hand-mirror** of `fovea.ts` (both
  carry the same 16 constants + two JSON schema-data blobs — B-P3 left them
  hand-synced). Extend the B-P1 emitter (or add a sibling target) to generate
  `schema.py` from `fovea.ts` the same way `pixel_formats.py` is generated from
  `pixel-formats.ts` — closing the one schema mirror B-P1 did not.
- **Category:** non-breaking.
- **Rationale:** A residual hand-kept list the registry pattern didn't reach.
  The `.fovea` schema names/encodings are the load-bearing viewer↔pyfovea
  contract (recorder-container.md §2b); a silent TS/Python drift here is
  exactly what a generated mirror prevents, and the generator infrastructure
  already exists (idempotent, checked-in, not build-wired).
- **Effort:** S. **Risk:** Low (byte-compare the emitted `schema.py` to the
  current one before committing; pyfovea pytest guards behavior).

## B-R2-P3 — Packet object↔struct field mapping via a descriptor table (scoped successor to B-P5)

- **Locations:** `core/src/Controller.cpp` (per-packet `*Packet` FNs:
  `VersionPacket`, `MirrorStreamPacket`, actuate/trigger/frame packers ~lines
  224–500), `lib/Protocol/Packet.h`, `core/dist/Controller/index.d.ts`.
- **Current → proposed:** Each packet type hand-writes a converter that, for the
  object case, calls `propertyMap(obj,"field",s.field)` per field and then
  `obj.Set("field", …)` per field — the same field list repeated twice per
  packet, and a third time in the `.d.ts`. **B-P5 was declined as L-effort
  build-time codegen on a hardware-gated surface.** Reframed, lower-risk
  variant now that B-P1 proved the pattern: a per-packet **field descriptor**
  (a `constexpr` list of `{name, member-pointer}`) that ONE generic
  `objectToStruct`/`structToObject` walks — no codegen, no build step, just a
  table the existing converters consume. `.d.ts` stays hand-written (or a later
  checked-in emitter derives it, à la B-P1).
- **Category:** non-breaking (emitted N-API shapes unchanged).
- **Rationale:** The coordinator's explicit question. `Controller.cpp` is 1121
  lines, much of it this field boilerplate; P4.1's FIN-trace debugging happened
  in this file, so reducing hand-repetition lowers the cost of the NEXT protocol
  change. Scoping to a field-descriptor table (not full factory/`.d.ts`
  codegen) captures most of B-P5's value at a fraction of its risk.
- **Effort:** M. **Risk:** Medium — member-pointer/`convert<T>` plumbing must
  preserve buffer-view exactness; keep B-P6's request-FSM area untouched (still
  post-bench). Gate on `02-serial-protocol.ts` + a rig round when hardware
  returns.

## B-R2-P4 — Recorder + `dtype.ts` `significantBits` consume `PIXEL_FORMATS` (cross-role seam with C)

- **Locations:** `app/orchestrator/recorder/index.ts` (channel-metadata build
  at ~line 189), `app/lib/util/dtype.ts` (`significantBits`, C-owned),
  `docs/schema/pixel-formats.ts`.
- **Current → proposed:** `index.ts` builds channel metadata
  (`dtype/shape/channels/pixelFormat/significantBits`) via `@lib/util/dtype`'s
  `dtypeOf` + `significantBits`; `significantBits()` re-derives depth from the
  format-name suffix — the same fact `PIXEL_FORMATS[*].significantBits` now
  holds authoritatively. Proposed: `significantBits`/`channels` resolve through
  `pixelFormatSpec(format)` (fallback to suffix for unknowns), so the recorder's
  written metadata can't disagree with the C++ readout.
- **Category:** non-breaking.
- **Rationale:** Residual duplication the B-P1 table can now absorb; the recorder
  metadata is what pyfovea/viewer decode from, so a single source here is the
  same drift-prevention argument as B-P1 itself.
- **Effort:** S. **Risk:** Low-med. **CROSS-ROLE with C:** `dtype.ts` is
  C-owned and is the C-P6 conformance target — this must be coordinated with C
  (likely folds INTO C-P6 rather than a separate B item). Planner-touch.

## B-R2-P5 — Bench/crash-recovery shared harness helpers (post-B-P4 self-duplication)

- **Locations:** `playground/bench-recorder/src/bench.ts`,
  `playground/bench-recorder/src/crash-recovery.ts`, `.../synth.ts`.
- **Current → proposed:** After B-P4 both scripts independently define an
  identical `compressionInjection()` (lz4/zstd module resolution), a near-
  identical `parseArgs`, and the same 3×raw-`BayerRG12p` + 1×processed-`Mono8`
  channel-spec array with its metadata → extract `benchChannels(rawPool,
  procPool)`, `compressionInjection(args)`, and `parseArgs` into `synth.ts` (or
  a `harness.ts`) both drive.
- **Category:** non-breaking.
- **Rationale:** I introduced this duplication landing B-P4 (self-flagged);
  it's small now but the channel-spec/metadata block is exactly where a future
  format/tier change would need editing in two places.
- **Effort:** S. **Risk:** Low (bench-only; smoke re-run covers it).

## B-R2-P6 — pyfovea `significant_bits`/`NUMPY_DTYPE` consult the generated `pixel_formats` mirror

- **Locations:** `pyfovea/src/pyfovea/dtypes.py`
  (`significant_bits`, `NUMPY_DTYPE`), `pyfovea/src/pyfovea/pixel_formats.py`.
- **Current → proposed:** `significant_bits()` re-derives depth from the format
  suffix (`endswith("12p")/("16")`) — `pixel_formats.PIXEL_FORMATS` already
  carries `significant_bits` per known format. Proposed: for a KNOWN format,
  read the table (keep the suffix path as the fallback for unknown/legacy names
  and the `declared` override). `NUMPY_DTYPE` stays (it's keyed by `Dtype`, a
  separate C-owned axis) but gets a comment pointing at the registry's `dtype`
  column.
- **Category:** non-breaking.
- **Rationale:** Closes the last format-fact that reads from name-string logic
  instead of the wave-2 single source; cheap now that `pixel_formats.py` is
  imported by `dtypes.py` already (B-P1 wired `BAYER_PATTERNS`).
- **Effort:** S. **Risk:** Low (pytest 33/33 guards; keep the fallback so torn
  legacy `.meta` still decode).

## B-R2-P7 — Trim/derive the `cv::Format` enum in `PixelFormat.h`

- **Locations:** `core/lib/Aravis/PixelFormat.h` (the 32-member
  `enum Format : int { U8C1 = CV_8UC1, … }`).
- **Current → proposed:** A 32-line hand-mirror of OpenCV's `CV_*` macros, of
  which the `PIXEL_FORMATS` table only ever names four (`U8C1/U8C3/U8C4/U16C1`).
  B-P1 deliberately left it (it's a cv typedef, not per-format). Proposed:
  reduce to the used set (or generate the named subset from the registry's `cv`
  column) so the enum stops advertising 28 members nothing constructs.
- **Category:** non-breaking.
- **Rationale:** Low-cost tidy; the dead members are a mild "which of these do we
  actually emit?" trap when reading the readout path.
- **Effort:** S. **Risk:** Low, but low value — it's a stable OpenCV mirror.
  Rank accordingly (do only if touching the file anyway).

## B-R2-P8 — Derive the `.d.ts` PixelFormat8/16/12p unions from the registry (residual B-P1 didn't reach)

- **Locations:** `core/dist/Aravis/index.d.ts` (`PixelFormat8`,
  `PixelFormat16`, `PixelFormat12p`, `PixelFormat`), `docs/schema/pixel-formats.ts`.
- **Current → proposed:** These three unions are still hand-maintained TS,
  split by depth for the `Frame.view()` overloads; B-P1 left them (byte-compat
  d.ts) with C-P6 slated to conformance-test them. Proposed: have the B-P1
  emitter also write the three unions (derivable: 8 = `significantBits===8`,
  16 = `===16 && !isPacked`, 12p = `isPacked`) into a checked-in `.d.ts`
  fragment the hand-written module `import`s — turning C-P6's runtime
  conformance check into structural single-source.
- **Category:** non-breaking.
- **Rationale:** The one PixelFormat list B-P1 explicitly did not reach; the
  `view()`-overload split is real semantics but is mechanically derivable.
- **Effort:** S-M. **Risk:** Low-med. **CROSS-ROLE with C-P6:** C owns the TS
  decode conformance — decide whether this replaces or complements C-P6's test.
  Planner-touch; sequence with C.

## B-R2-P9 — `Controller.cpp` internal naming not covered by B-P14

- **Locations:** `core/src/Controller.cpp`.
- **Current → proposed:** B-P14 (post-bench) already targets the phase-vocabulary
  renames (`frameAcceptedFactory`→`frameAckFactory`, `accepted_settled`→
  `ackDone`, …). Distinct wordy names it does NOT cover:
  `EXPECT_EXACTLY_ONE_ARGUMENT` (→ `ARG1`/`ONE_ARG`), `VersionPacketStaticProps`
  (→ `versionStatics`), `pendingSequences`, `propertyMap` (→ `readField`). Fold
  these into the B-P14 pass rather than a separate churn.
- **Category:** non-breaking.
- **Rationale:** Same legibility argument as B-P14; batching avoids a second
  rename sweep over the FIN-trace history.
- **Effort:** S. **Risk:** Low-med — inherits B-P14's "wait until post-bench so
  trace-history blame stays legible" constraint. Reference, don't land early.

---

### Cross-role seams flagged for the planner
- **B-R2-P4** and **B-R2-P8** both touch C-owned decode surfaces
  (`app/lib/util/dtype.ts` / the `.d.ts` unions C-P6 conformance-tests). They
  likely belong INSIDE C-P6's remit (single decode schema) rather than as B
  items — B owns the `PIXEL_FORMATS` source; C owns the TS consumers. Planner to
  assign.
- **B-R2-P1/P2** are pure B (protocol lib + pyfovea/docs-schema), no cross-role.
