# Manual-control split fovea (per-eye independent steering) — AS-BUILT

Status: CODE-COMPLETE (2026-07-10, `a45dd89`). User direct request. Pure precedence logic
unit-tested; gates green (vue-tsc + full vitest, 977 tests). UI/UX review + rig
pass owed (stage-f §Manual Control "Split fovea" / "Split reunify").

## Request

In Manual Control, make the L/R voltage `PosView`s interactable: dragging one
moves that fovea independently, and the wide-view footprints split into two
per-eye boxes while split. Dragging on the wide view reunifies.

## What shipped

Manual-control's session is DIRECT steer (no PID): one `target`/`targetAngle`
→ `inverseTriangulate` → per-eye `A2V` → the pacer pushes volts. The split
adds a per-eye volt override on top of that single solution.

- **Split state** (`app/modules/manual-control/split.ts`, pure + tested):
  `SplitVolts = { l: Pos | null; r: Pos | null }`, null = that eye follows the
  unified solution. `resolveVolts(unified, split)` = `{ l: split.l ?? unified.l,
  r: split.r ?? unified.r }` — **override > unified**, per eye. Session-local,
  NOT persisted; reset to unified on `idle()` so re-entry starts unified.
- **targetVolts precedence** — `targetVolts()` still solves the unified L/R from
  the steered angle, then `resolveVolts` overlays the per-eye pins. A pinned eye
  ignores the unified solution; an un-pinned eye keeps tracking it ("holds its
  current command" — nothing else moves it, so it stays put).
- **`splitEye({ side, volt })` command** — a `PosView` drag emits volt-space
  `Pos` values (its existing `@select` semantics, the same affordance
  calibrate-extrinsic binds); the renderer forwards each to `splitEye`, which
  sets `splitVolts[side]`. Volt-space, so it works uncalibrated.
- **Reunify (one rule)** — BOTH `setTargetFromPixel` (wide-view drag / `steer`
  pixel) AND `setTargetFromAngle` (set-point / programmatic target) call
  `reunify()` (clear both overrides) before applying. So any target command —
  a wide drag, a set-point, a raster step — returns both eyes to the shared
  solution. Releasing a `PosView` drag emits `null`; the renderer IGNORES it,
  so the eye HOLDS where dragged (no reunify on release).
- **Footprints — no rewiring needed, derived from volts by construction.**
  Manual-control did not draw per-eye pose boxes before (only a single target
  dot). Added two `<rect>`s on the wide (Center Wide) view sized to the fovea
  footprint (`size / max(1, zoom)`), positioned at NEW `L_PX`/`R_PX` telemetry
  = `A2P.C(V2A[role](volts[role]), false)` — the ACTUAL commanded per-eye
  volts, the same projection disparity-scope uses. Because they come from the
  live volts (not the target), they converge on the target while unified and
  physically separate while split — requirement 2 "falls out". THEME.L (cyan) /
  THEME.R (greenyellow) already distinguish the two boxes.
- **Degrade** — `A2P.C` throws without a center undistort (the disparity-scope
  hw-1 crash lesson); the projection is guarded (`triple?.undistort ? … :
  {0,0}`) and the renderer hides both boxes unless `state.undistortPipe` is
  advertised. The drag path is untouched by this — it never needs calibration.
- **UI affordances** — `PosView`'s canvas rect gets a `crosshair` cursor GATED
  on interactivity: the cursor and the mousedown drag-track engage only when a
  parent binds `@select` (four consumers — disparity-scope, multi-fovea,
  profiler, extrinsic PRV — use PosView as a pure display and must not
  advertise a drag; UI/UX review 2026-07-11). A per-eye `⟂ independent` badge
  under each voltage bar
  (in that eye's THEME color) lights while that eye is split; the Center Wide
  title reads `C — split (drag to reunify)` while either eye is split. The
  badge row is always laid out (opacity toggle) so nothing shifts.

## Precedence rule (summary)

commanded volts = per-eye split override, else the unified target solution.
Any target command (wide drag, set-point, programmatic angle) clears both
overrides. A voltage-bar drag sets one override; releasing it keeps the
override. Split is session-local and never persisted.

## Files

- `app/modules/manual-control/split.ts` (new — pure helpers)
- `app/modules/manual-control/session.ts` (split state, precedence, reunify,
  `splitEye`, `L_PX`/`R_PX` telemetry, idle reset)
- `app/modules/manual-control/contract.ts` (`splitEye` cmd; `split`/`L_PX`/
  `R_PX` telemetry)
- `app/modules/manual-control/index.vue` (drag wiring, footprint rects, badges)
- `app/src/components/PosView.vue` (crosshair cursor — additive only)
- `app/test/manual-control-split.test.ts` (new — 5 tests)
- `docs/manual/manual-control.md`, `docs/hardware/stage-f.md` (§Manual Control)

## Open / calls

- The non-pinned eye follows the LIVE unified solution, so a Verge/Vertical
  Shift slider change while split still reframes the un-split eye. This matches
  "holds its current command" for the pointer sense (nothing moves it on its
  own) while keeping the global sliders live on the un-split eye. Deliberate;
  flag for the rig pass if the desired feel is a hard freeze instead.
- Round-trip: a drag → `splitEye` → session → pacer → `volt` telemetry → the
  `PosView` marker follows at input rate (same path calibrate-extrinsic's
  overrides use). No local optimism; acceptable at pointer rate.
