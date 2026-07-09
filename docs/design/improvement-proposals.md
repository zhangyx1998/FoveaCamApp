# FoveaCamApp — UI/UX Improvement Proposals (Phase 2)

> Grounded in `design-language.md`. Scope is **consolidation + dark-lab operator UX**, NOT a
> reskin or framework migration. Each proposal is independently landable. The planner and
> user rule before any implementation.
>
> Priority = value ÷ effort for a dark-room rig operator (glare control, glanceability at
> distance, error visibility). Effort: **S** ≈ hours, **M** ≈ a day, **L** ≈ multi-day.
> Nothing here changes behavior of the camera/orchestrator path — all render-layer only.

Ranked highest-value first.

---

### P1 — Semantic color tokens in `:root` (one palette module) — **effort M, risk Low**
**Problem:** ~180 raw hex literals; error red exists as 8 values, success green as 7, accent
blue as 5 (`design-language.md` §8.1–3). No tokens file exists (`app/src/index.css` is the
only global sheet). Every file re-picks a color by eye.
**Proposal:** Add `:root` custom properties in `index.css` (or a small `tokens.css`) for the
*already-implicit* ramps — `--bg-chrome:#111`, `--bg-surface:#222`, `--text/-muted/-dim`
rungs, and **named semantic roles** `--accent`, `--ok`, `--warn`, `--danger`, `--danger-bg`.
Pick one canonical value per role (e.g. accent `#08c`, danger `#a00`/`#c0392b`, ok `#4caf50`
to match the *ruled* progress green). Migrate literals to `var(--…)` incrementally; the token
file is the deliverable, migration can be staged.
**Affected:** all `<style>` blocks (incremental); `index.css`; `@lib/camera-config THEME`
optionally aliased to `--role-l/c/r`.
**Why first:** unblocks P2/P3/P4 and every consistency fix; zero behavior risk; a dark room
makes exact contrast matter.

---

### P2 — Unify the error/crash identity (+ define the crash-report UI) — **effort M, risk Low**
**Problem (the crux, §7 + §8★):** three disconnected error surfaces —
`SessionStatus` (`#c0392b`), `ErrorBoundary` (foreign Flat-UI `#e74c3c`/`#3498db` + a
different font stack), and **a process/orchestrator crash renders nothing**. The one moment
an operator most needs a clear, recognizable signal is the least consistent.
**Proposal:** (a) Re-skin `ErrorBoundary` and `SessionStatus` onto the P1 `--danger` tokens
and the app font — one error look. (b) Give the incoming crash-report channel a concrete UI:
reuse the `ErrorBoundary` full-panel shell (icon + message + scrollable detail + primary
action), but drive it from the orchestrator crash event, with a persistent, high-contrast
"Session crashed — [Restart] [Copy report]" banner that **cannot** be missed at distance
(large, `--danger-bg` fill, not a hover-reveal). (c) Standardize invalid-input signalling on
`--danger` only, dropping the yellow `#ff0` double-signal (§8.4).
**Affected:** `ErrorBoundary.vue`, `SessionStatus.vue`, `AppWindow.vue` (crash host),
`SaveControls`/`RecordControls` invalid state.
**Risk:** Low; needs the crash-channel event shape from the lifecycle wave (coordinate).

---

### P3 — A shared `<Button>` component — **effort M, risk Low**
**Problem:** ≥8 independent button implementations, `button.action` copy-pasted between
Record/SaveControls (§8.5, §8.8). No `<Button>` exists.
**Proposal:** One `<Button variant="primary|danger|ghost|icon" :disabled>` on P1 tokens,
covering the three existing shapes (solid accent, solid danger, ghost/icon). Adopt in the
high-traffic controls first (Record/Save/calibrate action rows, title-bar icon buttons).
Bundles a single disabled look (`opacity .5 + not-allowed`), one focus ring (`--accent`), one
active idiom — resolving the 3 disabled / 4 active / 2 focus variants (§7).
**Affected:** RecordControls, SaveControls, calibrate-intrinsic/extrinsic, AppWindow
icon-button, ProgressMonitor dismiss, NavBack. Incremental adoption.
**Risk:** Low; purely presentational.

---

### P4 — Consistent focus / hover / disabled states (a11y + glare) — **effort S, risk Low**
**Problem:** two focus-ring colors, three disabled looks, four active idioms (§7, §8.11).
No global `:focus-visible`.
**Proposal:** Global `:focus-visible { outline: 2px solid var(--accent) }` in `index.css`,
one disabled mixin, one hover tint scale (`--fff1…4` aliased). Small, mostly deletions once
P1/P3 land. Improves keyboard operability and gives predictable, low-glare highlight states.
**Affected:** `index.css` + removal of local overrides.
**Risk:** Low.

---

### P5 — Make clickable affordances visible (hover-reveal audit) — **effort M, risk Med**
**Problem:** the hover-reveal idiom (good for glare) hides *actionable* controls until
hover: StreamView expand button and outline, record tooltip, ProgressMonitor `×`, record
chips that are clickable but look static (`calibrate-intrinsic:340`), thumbnails
(§7). At rig distance an operator can't tell what is interactive.
**Proposal:** Keep hover-reveal for *decoration/telemetry*, but give **actionable** elements a
persistent low-contrast affordance (a faint always-on outline/cursor/underline that
intensifies on hover) — e.g. record chips get `cursor:pointer` + a 1px idle border; the
stream expand icon keeps a minimum `opacity: 0.35` instead of hiding. Audit-driven, per
element.
**Affected:** StreamView/FrameView, RecordButton, record-chip lists, ViewerWindow thumbnails.
**Risk:** Med — changes the visual "resting" state; needs a live-rig glance test.

---

### P6 — Extract the split `<SplitView>` (left stream / right panel) — **effort M, risk Low**
**Problem:** the dominant module layout (left `#111` stream / right `#222` panel /
`border-left:2px #333` / `padding:1rem`) is re-implemented in ≥6 modules
(`design-language.md` §4, §8.6).
**Proposal:** One `<SplitView>` (or standardize on the existing `HorizontalDivision`) with a
`#panel` slot carrying the canonical panel chrome. Modules opt in incrementally. Guarantees
identical panel padding/border/scroll behavior across every calibrate/control app.
**Affected:** calibrate-intrinsic/extrinsic/drift, disparity-scope, manage-cameras,
manual-control.
**Risk:** Low-Med (layout regressions per module; migrate one at a time).

---

### P7 — Extend the L/C/R role-color system to full reach — **effort S, risk Low**
**Problem:** `THEME{L:cyan,C:orange,R:greenyellow}` is the one good semantic color contract
but reaches only Badge/CameraRole/StreamView outlines. Many per-camera surfaces
(record-stream rows, viewer series, multi-fovea slots `#ffb000`/`#fa0`, disparity views) use
unrelated ad-hoc colors instead of the eye's known L/C/R mapping.
**Proposal:** Alias `THEME` into tokens (`--role-l/c/r`) in P1 and apply role color to every
per-camera surface (stream row accents, series lines, slot badges) so "cyan = Left" holds
app-wide. High glanceability payoff for a stereo rig.
**Affected:** RecordButton stream table, ViewerWindow series palette, multi-fovea,
disparity-scope.
**Risk:** Low.

---

### P8 — Consolidate iconography & spinners — **effort S, risk Low**
**Problem:** three icon systems (FontAwesome, hand-rolled SVG, HTML entities) and **three
spinner implementations** (ProgressMonitor CSS, Loading SVG, record-blink) — §3, §7.
**Proposal:** Standardize on FontAwesome (already a dependency) for glyphs; replace the
entity ✓/⏳ and hand-rolled arrows where an FA equivalent exists (keep bespoke SVG only for
frame annotations that *must* be geometric). One shared `<Spinner>`. Pure cleanup.
**Affected:** ProgressMonitor, Loading, NavBack, RecordButton.
**Risk:** Low.

---

### P9 — Font token + kill re-declared stacks — **effort S, risk Low**
**Problem:** the monospace stack is re-declared as a raw literal in ≥6 places and a
*different* stack in ErrorBoundary (§3, §8.10).
**Proposal:** `--font-mono` token in `:root`; replace literals and the ErrorBoundary
Consolas stack with it. Trivial, removes a whole drift class. Optionally define a minimal
type scale (`--fs-sm/base/lg`) to replace ad-hoc `0.8em`/`1.4rem`/`2rem`.
**Affected:** StreamView, FrameView, PosView, ErrorBoundary, index.css.
**Risk:** Low.

---

### P10 — Dark-theme contrast pass for telemetry text — **effort S, risk Low**
**Problem:** the muted-grey text ramp (`#666`–`#999`) on `#111`/`#222` is used for live
telemetry and secondary labels (RecordButton `th #778`, footnotes `gray`, `.notice #888`).
Several rungs fall below comfortable contrast for glance-at-distance in a dark room, and the
lowest (`#444` "No Frame") is nearly invisible.
**Proposal:** Once P1 names the ramp, bump the *informational* rungs (any live number or
actionable label) to a validated minimum contrast against `--bg-surface`; keep the very-dim
rungs only for truly decorative/idle text. A token-level tune, no structural change.
**Affected:** token values in P1; RecordButton tooltip, StreamView footnotes, empty states.
**Risk:** Low.

---

## Dependency / sequencing note
P1 is the keystone — P2, P4, P7, P9, P10 all consume its tokens; P3 consumes P1; P6/P8 are
independent. Suggested order: **P1 → P2/P3 (parallel) → P4/P9 → P7/P10 → P5/P6/P8**.
P2 must coordinate with the lifecycle crash-report wave for the event shape.
</content>
