# Multi-fovea recording — churning per-target streams into the recorder node

Status: **RULED — in execution** (user 2026-07-09). Successor to
[capture-recorder-nodes](./capture-recorder-nodes.md) — reuses its recorder
thread node and extends it for the multi-fovea app's churn semantics.

## Intent (user ruling)

Recording **per-target fovea pipes is the intention** of multi-fovea support.
A multi-fovea recording captures:

- **Every live per-target fovea pipe** (`camera/<serial>/undistort/fovea/<slot>`
  — the composed BGRA8 tiles, recorded as-is at pipe depth), **including
  targets armed/disarmed/resized mid-recording** (C-20 churn is the app's
  premise; a snapshot-at-start recorder betrays it).
- **The full-depth raw wide streams** (`camera/<serial>/raw`, ruled
  2026-07-09) — same on-demand raw pipes + ringDepth 48 as manual-control
  recording; full offline re-analysis accepted at the file-size cost.
- **Per-frame target telemetry** via the existing extras channel: track
  score, crop rect/origin, triangulated 3D position when calibrated.

## Rulings

1. **Dynamic streams**: the recorder node gains `addStream(name, pipeId)` /
   `removeStream(name)` usable mid-recording. MCAP registers channels
   mid-file; the worker's consumer set becomes dynamic (counters/writeSeq/
   drainTargets keyed maps already are). `removeStream` sets that stream's
   drain target (R-1 semantics) and lets the consumer exit; the channel stays
   in the container. Finalize drains whatever set is live.
2. **Frame schema carries per-frame dims** — DELIBERATE schema version bump
   (the §1 compatibility promise, exercised on purpose): messages gain
   `width`/`height` (a fovea resizes continuously inside its max-footprint
   ring). Channel metadata keeps max/nominal shape; the viewer honors
   per-frame dims and tolerates channels appearing mid-file + seq gaps.
3. **Recorder stays a pure consumer of fovea pipes** — it NEVER advertises
   them (the capture-recorder R-3 exclusivity rule). The compose
   materializer owns them. If the renderer decomposes a slot mid-recording
   (target destroyed / window closed) the pipe closes → the consumer drains
   the tail and the stream ends. That IS the churn semantics, not an error.
4. **Raw-pipe acquisition becomes refcount-shared**: `camera/<serial>/raw`
   ids are global, and manual-control recording, capture shots, and now
   multi-fovea recording can all want them. `app/orchestrator/raw-pipe.ts`
   grows a single-owner refcounted acquire/release (ONE advertise per id,
   attach refcounted) so two features never advertise the same pipe id —
   fixing the R-3 class problem at the source instead of per-feature guards.
   Existing manual-control/capture call sites move onto it.
5. **Extras**: the session answers `onFrame` for fovea streams with the
   target's track state at that seq (score, rect, 3D position); raw wides
   post no extras (`extrasStreams` gating). FIN voltage binding remains
   firmware-gated exactly as in manual-control.
6. **UI**: a record button in the multi-fovea drawer (RecordControls
   pattern), Cmd-R via the existing `onRecorderTrigger` consumer,
   `recording:finished` → auto-open viewer (existing main.ts path).
7. **FIFO slack**: fovea materializer `ringDepth` 4 → evaluate a bump
   (512²·4 B ≈ 1 MiB/slot; depth 8 costs ~4 MiB extra per fovea) with the
   soak's drop accounting deciding; keep latest-wins renderer reads
   unaffected.
8. **Interleaved execution** (standing directive): I-1 (recorder dynamics +
   schema + viewer) → R-1 (review/opt) → I-2 (session wiring + raw-pipe
   refcount + UI) → R-2 (review/opt + soak + close).

## Phases

### Phase 1 (wave I-1) — recorder node: dynamic streams + per-frame dims

`app/orchestrator/recorder-node.ts` (+ `recorder/schema.ts`):
- `addStream`/`removeStream` on the handle + worker messages; dynamic
  consumer set; finalize/drain over the live set; stats fold over a
  changing key set.
- Frame message carries per-frame `width`/`height` (schema version bump in
  `recorder/schema.ts`; channel metadata documents max shape).
- Stream-ends-on-pipe-CLOSED is a normal exit (already true via
  runStreamConsumer Closed handling — verify + test).
- Viewer (`app/orchestrator/viewer/decode.ts` / `player.ts` /
  `sessions/viewer.ts`): honor per-frame dims, channels appearing mid-file,
  per-stream time ranges shorter than the container.
- Tests: unit (dynamic add/remove state machine, resize sequences) + a
  churn soak (`*-soak.ts` pattern): streams added/removed mid-run, dims
  varying per frame, exact accounting on stable segments.

### Phase 2 (wave I-2) — multi-fovea session wiring + shared raw pipes

- `raw-pipe.ts` refcounted acquire/release; manual-control recording.ts +
  capture path migrated onto it (guards in manual-control/session.ts stay —
  capture-vs-recording exclusivity is still policy, but clobber becomes
  structurally impossible).
- `app/modules/multi-fovea/session.ts`: recording controller — streams =
  live slot pipes + raw wides; arm/disarm hooks call add/removeStream;
  extras from the runtime's per-target state; `recording:finished` post.
- `app/modules/multi-fovea/index.vue` (+ contract.ts): record button,
  Cmd-R, recording stats surface.

## Gates

vue-tsc 0 / vitest / soaks / vite build at wave closes; core untouched
(consumer-side only). No Electron launches. Rig items accumulate in
`docs/hardware/stage-f.md` §"Multi-fovea recording".
