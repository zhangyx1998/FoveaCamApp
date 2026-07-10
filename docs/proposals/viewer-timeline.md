# Viewer timeline — multi-track correlation UI

Status: **SHIPPED (code-complete 2026-07-09, `9efc6bf`, all 11 rulings; UI pass owed — stage-f §Standalone viewer + timeline)**. Builds directly on
[standalone-viewer-and-fcap](./standalone-viewer-and-fcap.md) (d28cd7a: the
viewer is orchestrator-free; playback lives in a per-window worker). The
single-stream-at-a-time viewer defeats the system's purpose — correlating
between views.

## Rulings (user, verbatim intent)

1. **Timeline with multiple tracks.** The default MASTER track is the wide
   angle view (as defined by the recorder — the container's wide/center
   designation). Other streams are visualized as blocks in tracks below the
   master, like a video editor in read-only mode.
2. **Track packing**: a track can hold multiple stream blocks as long as
   they don't overlap; the viewer optimizes for the minimal number of
   tracks (greedy interval packing by start time — optimal for min-track
   interval scheduling). *Planner reading of the (truncated) drag ruling*:
   the user can DRAG AND DROP blocks between tracks to override the auto
   layout (FCPX-style); manual placement persists (sidecar) and wins over
   auto-packing. Flagged for confirmation.
3. **Preview panel**: the upper half of the window shows ALL active streams
   under the current playhead (enabled streams whose block spans the
   playhead), as tiles.
4. **"3D View" dropdown** merges the left/right views of the same stream
   into a 3D view. Options today: `disabled | left-only | right-only |
   anaglyph`. The enum is extensible — 3D DLP projectors and other 3D tech
   may follow.
   - **Amendment (user, 2026-07-09): 3D mode is GLOBAL, not per pair.** One
     "3D View" control in the preview-panel header applies the chosen mode to
     EVERY L/R pair at once (unpaired streams are unaffected); the per-pair
     block dropdowns are removed. The sidecar's `threeD` changes from a
     per-pair `Record<base, mode>` map to a single mode value; an OLD per-pair
     sidecar is collapsed on read (first non-`disabled` value wins, else
     `disabled`) and rewritten in the new shape on the next save — no version
     bump and no confirm prompt (a lossless-enough upgrade, not corruption; the
     ruling-10 corrupt/mismatch flows are unchanged).
5. **Disable via "v"**: focusing a stream block and pressing `v` toggles
   the stream disabled (FCPX idiom). Disabled streams are hidden from
   previews (and rendered dimmed in the timeline).
6. **Draggable preview height**: the preview panel reserves a minimum
   height; the LOWER (timeline) panel can collapse into an up-arrow (the
   existing drawer idiom).
7. **Adjustable stream tile width** (preview tiles).
8. **Sidecar UI state**: ALL viewer UI state persists as a sidecar file
   next to the `.fcap`; the `.fcap` itself is opened READ-ONLY.
9. **Z order → tile order**: the track stacking order (master track first,
   then tracks top→bottom) determines the order of the preview tiles —
   dragging a block to another track therefore also reorders its tile.
10. **Sidecar lifecycle (amendment, user 2026-07-09)**: greedy fitting runs
    ONLY at ui.json INITIALIZATION (first open, or reset). After that the
    sidecar is the source of truth — dragging mutates track assignment in
    ui.json directly (creating/removing tracks as needed; auto-pack is
    never re-applied on top of user placement). A **Reset UI state**
    button re-initializes ui.json (re-runs greedy fit, defaults).
    Corrupted or MISMATCHED ui metadata (e.g. channels that don't match
    the container) → CONFIRM with the user before reinitializing and
    overwriting the json — never silently discard their layout.
11. **Exclusive ownership**: ui.json is owned exclusively by the viewer,
    duplication-free — the one-window-per-file dedupe makes that window's
    worker the single writer; no other process/surface writes it, and a
    reopen must not spawn a second writer.

## UI round 2 rulings (user, 2026-07-09)

A second UI pass over the shipped viewer. **AS SHIPPED** (code-complete
2026-07-09) — pure logic + tests landed; rig/UI pass still owed (stage-f
§Standalone viewer + timeline).

1. **Draggable playhead, no separate range input.** The scrub slider is
   removed; the playhead line itself drags along the timeline. Its hit region
   is a wide (~14 px) invisible strip around the 1 px line (`cursor:
   ew-resize`). Clicking a track lane still seeks. *AS SHIPPED:* click-seek and
   playhead drag share one pure mapping, `nsAtClientX` (clamped to
   `[0, durationNs]`), unit-tested.
2. **Playhead decorations.** Hourglass-half ornaments sit at the top
   (downward ▽) and bottom (upward △) of the line — together an hourglass split
   by the timeline. *AS SHIPPED:* CSS-triangle ornaments + line take a single
   `--ph-color` custom prop — **solid red (`--danger`) while playing**,
   idle-neutral (`--text-faint`) when paused. Snap color change, no transition.
3. **The divider bar becomes the transport bar.** The draggable split divider
   now hosts the transport: **LEFT** play/pause + rate; **CENTER** the current
   timecode as `HH:MM:SS.sss` (monospace, fixed 13ch so ticking digits never
   reflow); **RIGHT** the global **3D View** dropdown (moved from the preview
   header) + a property-panel toggle + the collapse chevron. *AS SHIPPED:* the
   bar is the resize drag handle; the left/right clusters are interactive
   islands (`@pointerdown.stop`) — the TitleBar draggable-strips + no-drag-slot
   pattern. The bar is **always present** when a file is open and stays
   fully usable when the timeline is collapsed (it *is* the drawer edge — the
   old `▲ timeline` drawer and separate `▼` button are gone; one chevron on the
   bar folds the tracks away and back, and dragging the collapsed bar upward
   re-expands it).
4. **Property panel.** A toggleable right-side inspector of the *focused*
   stream showing the popover's static + live stats (reused verbatim from
   `stats.ts` + the `get-stats`→`stats` plumbing) **plus** channel id/topic,
   encoding, absolute (wall-clock) + relative (in-recording) first/last
   timestamps, span, message count, avg fps, format · bit-depth · codec,
   resolution, live decode rate / frames-decoded / shown-frame-vs-playhead,
   enabled state, track assignment, and pair side + 3D mode when paired. Empty
   state: a dim centered "Select a stream to inspect". *AS SHIPPED:* placement
   is the right edge of the preview area (an FCPX-style inspector — it doesn't
   disturb the horizontally-scrolling tile strip and gives a tall column for
   the detail list); it is resizable by its left edge. Visibility + width
   persist in the sidecar (`panelOpen`, `panelWidth`) — tolerant read, no
   version bump, absent → closed. The worker now forwards `startEpochMs` (the
   recording's wall-clock start) in the `opened` payload for the absolute
   timestamps.
5. **Cross-highlighting.** Hovering OR focusing a track block highlights its
   preview tile and vice versa — bidirectional, instant on/off. *AS SHIPPED:* a
   shared highlight set keyed by stream id (`hoverChannels` ∪ `focused`); a
   merged-pair tile highlights both member blocks and either block highlights
   the tile. The treatment is a `box-shadow` ring (blocks + tiles) — never a
   layout-changing border.
6. **Everything else keeps working:** drag blocks between tracks, `v` disable,
   the right-click stats popover (kept — the panel is the persistent surface,
   the popover the quick one), reset/confirm flows, and the tile-width slider
   (stays in the preview header).

**Sidecar delta (no version bump):** `+panelOpen: boolean` (absent → false),
`+panelWidth: number` (absent → `DEFAULT_PANEL_WIDTH`, clamped
`[MIN_PANEL_WIDTH, MAX_PANEL_WIDTH]`).

## Design

- **Master detection**: the channel matching the container's wide-camera
  designation (`fovea:wide-camera` metadata / manual-control's `center`
  stream); fallback = the first frame channel, flagged in the UI.
- **Blocks**: one block per frame channel, spanning [first, last] message
  log-time (channels armed mid-recording start mid-timeline; truncated
  files span what was recovered). Telemetry/descriptor channels are not
  blocks — they stay bound to their frame streams (bbox overlays).
- **3D pairing**: L/R of "the same stream" pair by the container's
  side-tagged naming (left-/right- prefixes or L/R serial mapping via
  metadata); a pair under a non-`disabled` 3D mode renders as ONE tile
  (anaglyph = renderer-side channel merge on the decoded RGB — no core
  dependency); `left-only`/`right-only` shows that side alone;
  `disabled` = two independent tiles.
- **Sidecar**: `<recording>.fcap.ui.json` (versioned `{ v: 1, ... }`):
  track overrides, disabled set, GLOBAL 3D mode (ruling 4 amendment — a
  single value, old per-pair maps collapsed on read), panel split, tile
  width, last playhead. Debounced write-through from the window's worker
  (the only writer). Absent → silent init; corrupt/mismatched → user
  confirmation before overwrite (ruling 10 governs). The MCAP reader path
  is verified read-only.
- **Ruled interaction principles apply** (design-language.md): snap
  drag/drop and divider drags (no eased transitions on the control path),
  instant hover/focus cues on blocks, and layout stability — tiles
  reserve space; toggling a stream must not reflow the timeline.

## Execution

One worker wave over the standalone-viewer surface (`app/src/viewer/*`,
`ViewerWindow.vue`, viewer protocol/worker, preload-viewer for sidecar
IO). Rig/UI pass items append to the standalone viewer's checklist in
stage-f.
