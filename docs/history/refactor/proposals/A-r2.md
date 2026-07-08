# Coder A — optimization survey ROUND 2 (A-17)

Re-survey of the A-owned surface AFTER waves 1+2. Focus per dispatch: what the
new helpers (`fovea-pipeline`, `useFrames`, `marker-calibration`, `WINDOWS`
table, typed bridge registry, `CAMERA_CONTROLS`, session `status`/`fail`)
EXPOSED or left behind — residual repetition, wordy survivors, and better-fit
solutions the new structure now makes cheap. Ranked by value.

**Not re-proposed (still-open / deferred, per dispatch):** A-P1 (resource-scoped
session lifecycle — the full runtime rewrite), A-P7 (contract camelCase), A-P12
(explicit frame address), A-P6 (StreamView/FrameView split, post-GUI-smoke).
Several items below are the *non-breaking primitive layer underneath* A-P1 and
are sequenced to de-risk it — flagged inline.

---

## A-R2-P1. Session teardown primitives (disposer bag + lease release)
Locations: `modules/{calibrate-extrinsic,calibrate-drift,calibrate-distortion,
manual-control,disparity-scope,multi-fovea}/session.ts` idle bodies.

Current → proposed: every camera session hand-rolls the same teardown triad —
`const disposers: Array<()=>void> = []` … `for (const d of disposers) d();
disposers.length = 0;` … `if (triple) for (const l of Object.values(triple.leases))
l.release();` (6 sessions, verbatim). Add two tiny Vue-free primitives next to
`marker-calibration.ts`/`fovea-pipeline.ts` (e.g. `orchestrator/session-resources.ts`):
a `DisposerBag` (`add(fn)`, `dispose()` — drains and clears) and
`releaseLeases(tripleOrLeases)`. Sessions keep their own idle ordering; only the
loops collapse.

Category: **non-breaking**. Rationale: 6× verbatim teardown loops; the exact
class of code the still-open A-P1 will subsume — landing the *primitives* now
removes the duplication AND gives A-P1 a ready-made building block (de-risks the
breaking rewrite). Effort: S. Risk: low.

## A-R2-P2. Triple-acquisition guard → `status`/`fail` adoption
Locations: `modules/{calibrate-distortion,calibrate-drift,multi-fovea,
disparity-scope,manual-control}/session.ts` `activateSession()` heads.

Current → proposed: 5 sessions open with the identical guard `const t = await
leaseCalibratedTriple(); if (!t) { s.telemetry({ ready: false }); return; }
triple = t;`. Extrinsic has the same shape twice (matchTriple + loadIntrinsic).
Add `acquireTriple(s)` (in `@orchestrator/calibration`) that returns the triple
or, on failure, publishes `ready:false` AND `s.fail("Cameras unavailable — held
by another app or not connected")` — wiring the A-P13 channel that today only
manage-cameras uses. Callers become `const t = await acquireTriple(s); if (!t)
return;`.

Category: **non-breaking** (additive `fail`). Rationale: 5–6× copy of a guard
that currently fails SILENTLY (ready:false only) — A-P13 exists precisely to make
this user-visible, but no control session adopted it. Effort: S. Risk: low-med
(adds a telemetry emit on the failure path; behavior-additive).

## A-R2-P3. `useController()` renderer composable
Locations: `modules/{calibrate-extrinsic,calibrate-drift,calibrate-distortion}/
index.vue` (and any control module reading mirror pos).

Current → proposed: three calibration views repeat `import { controller as
controllerContract } from "@lib/orchestrator/contracts"` + `const ctrl =
useSession(controllerContract, "controller")` then read `ctrl.telemetry.{pos,dv,
connected}`. Add `useController()` in `@lib/orchestrator/client` (or a
`composables/` file) returning the typed controller session. One import, one
call.

Category: **non-breaking**. Rationale: the exact "remaining `useSession` wiring
duplication" the dispatch called out — same 2-line boilerplate + magic
`"controller"` string in ≥3 files. Effort: S. Risk: low.

## A-R2-P4. Marker-target renderer controls (the renderer half A-P4 left behind)
Locations: `modules/{calibrate-extrinsic,calibrate-drift,calibrate-distortion}/
index.vue`.

Current → proposed: A-P4 unified the orchestrator side of the L/C/R marker
trackers, but each view still hand-writes three near-identical inputs
`@change="(e) => session.call('setTargetId', { role: 'X', id: Number((e.target
as HTMLInputElement).value) })"` plus the role labels. Add a
`<MarkerTargetInputs :session>` component (or `useMarkerTargets(session)`
composable) driving the L/C/R id inputs off one place — the renderer twin of
`marker-calibration.ts`.

Category: **non-breaking**. Rationale: 3 views × 3 inputs of the same
`setTargetId` + `Number(...)` boilerplate; pairs the orchestrator helper so the
marker-calibration family is DRY on both sides. Effort: S-M. Risk: low.
Cross-ref A-P4.

## A-R2-P5. Ship the A-P13 status banner everywhere (shared component)
Locations: all `modules/*/index.vue`; `src/windows/{App,Viewer,Welcome}Window.vue`.

Current → proposed: A-P13 gave every session a `status.error`, but only
manage-cameras renders it (a bespoke `.camera-error <p>`). Add a
`<SessionStatus :session>` banner component and drop it into the app-window
shell (once) so ANY session's activation failure surfaces, not just
manage-cameras. Removes the one-off styling and makes the A-P13 investment pay
off fleet-wide.

Category: **non-breaking**. Rationale: better-fit made cheap by A-P13 — the
channel exists and is seeded; one shared component vs. per-module reinvention.
Effort: S. Risk: low. Seam: the **profiler window (C-owned)** could also surface
per-session `status.error` — note for C, not A's to wire.

## A-R2-P6. `resetTelemetry()` runtime helper
Locations: `ServerSession` (`orchestrator/runtime.ts`); idle bodies of the 7
camera sessions.

Current → proposed: each idle hand-spells the telemetry reset back to defaults
(`s.telemetry({ ready:false, detection:{L:null,C:null,R:null}, ... })`) — the
default values are ALREADY in `contract.telemetry`, duplicated by hand. Add
`s.resetTelemetry(keys?)` that republishes the contract defaults (all, or a
named subset). Idle becomes `s.resetTelemetry()`.

Category: **non-breaking** (additive runtime method). Rationale: 7× hand-copied
default maps that can silently drift from the contract; another A-P1 building
block. Effort: S. Risk: low-med (must republish EXACT defaults — pin a test).

## A-R2-P7. `bindField()` — writable telemetry↔command binding composable
Locations: `modules/manage-cameras/CameraConfig.vue` (`field`/`numField`); the
same read-telemetry / write-via-`set`-command pattern recurs wherever a control
is bound.

Current → proposed: `CameraConfig.vue` defines local `field(key)`/`numField(key)`
→ `computed({ get: view[key], set: session.call('set', …) })`. Lift a generic
`bindField(session, key, cmd)` (writable `computed` over a command) into
`@lib/orchestrator/client` so any module binds a control without re-deriving the
getter/setter dance.

Category: **non-breaking**. Rationale: a reusable renderer primitive currently
trapped in one component; grows as more modules bind editable state. Effort: S.
Risk: low.

## A-R2-P8. Fold `APPS` into one app registry (post-WINDOWS)
Locations: `lib/windows.ts` (`APPS`), `src/windows/app-registry.ts` (loader map),
`windows/*.html`, `vite.config.ts` (entries).

Current → proposed: A-P8 gave window CLASSES a `WINDOWS` table and A-P9 added a
consistency test but deliberately kept the loader map + per-app HTML explicit.
The per-APP metadata is still split: `APPS` (id/title/session/group) here,
component loader there, HTML entry elsewhere. Unify the *metadata* into one
registry keyed by app id (title/session/group/dev + a typed loader ref) that
`WINDOWS.app`, `allEntries()`, and the launcher all derive from — keep the
explicit loader map A-P9 kept (vite static-analysis reason), just co-locate it.

Category: **non-breaking**. Rationale: adding/removing an app still touches 3-4
files; the WINDOWS table proved the table pattern — extend it to the per-app
axis. Effort: M. Risk: med (vite entry/glob analysis is picky — keep loaders
explicit; the A-P9 consistency test guards drift). No cross-role.

## A-R2-P9. Passthrough view-tap primitive (`bindViews`)
Locations: `modules/{calibrate-extrinsic,calibrate-drift}/session.ts` (and any
session whose `onView` is a bare `s.frame` passthrough).

Current → proposed: extrinsic/drift each define `function onView(role, raw) {
s.frame(role, raw); }` + three `disposers.push(lease.onView((v) => onView(role,
v)))`. Add `bindViews(leases, disposers, onView?)` to the P1 session-resources
lib — default publishes each role's frame; a callback overrides where a session
processes the tap (distortion's fovea warp). I flagged this as deliberately
out-of-scope in A-P4 (distortion diverges); with a per-role callback it's now a
clean primitive.

Category: **non-breaking**. Rationale: closes the A-P4 out-of-scope note; small
but removes the last verbatim triple in those two sessions. Effort: S. Risk:
low.

## A-R2-P10. Short-name pass on wave-2 survivors
Locations: scattered — new/edited files in waves 1-2.

Current → proposed: A-P14/C-P10 did the bulk rename pass, but a few wordy names
survived or were introduced: e.g. `stopPreviewLoop`/`stopServo` pairs and
`previewVolts` in calibrate-extrinsic, `autoAvailableKey`/`availableKey` schema
fields (fine as-is), `pixel_format_options` (wire, defer to A-P7). Small curated
map only — no churn for its own sake, batched with adjacent functional work.

Category: **non-breaking**. Rationale: keep the project's compact-noun voice
consistent as the surface grew; low value alone, cheap when piggybacked. Effort:
S. Risk: low. (Wire-name renames belong to the approved A-P7 wave — not here.)

---

### Cross-role seams
- **A-R2-P5** exposes `status.error` fleet-wide; the **C-owned profiler window**
  is the natural place to also aggregate per-session errors — a C follow-up, not
  A's to wire.
- **A-R2-P2/P6** are the non-breaking primitive layer under the approved-but-
  open **A-P1** (lifecycle unification, breaking). Landing them first shrinks
  A-P1's diff and its risk; recommend sequencing them before A-P1 rather than
  letting A-P1 absorb them cold.
- No B/native or SHM seams touched by this round.
