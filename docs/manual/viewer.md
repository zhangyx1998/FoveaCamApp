# Viewer

The Viewer plays back a `.fcap` recording as a multi-track timeline: a preview panel of live tiles on top, a video-editor-style timeline of stream blocks below. It is a standalone window — it plays recordings entirely on its own and does **not** need the cameras, the orchestrator, or any running app. Use it to review, scrub, and compare the streams you recorded with [Recording](./recording-and-capture.md).

**Prerequisites:** none. The Viewer works with no cameras connected. All you need is a `.fcap` recording file (legacy `.fovea` files also open, read-only).

The recording itself is always opened **read-only** — the Viewer never modifies it. Your layout and playback choices are saved separately in a small **layout sidecar** (a `ui.json` file next to the recording); see [Layout persistence](#layout-persistence).

---

## Opening a recording

There are several ways to open one, and each opens its own Viewer window (opening the same file again just focuses the existing window):

- **Automatically** — when you stop a recording, the Viewer opens on the new file (see [Recording](./recording-and-capture.md)).
- **`Cmd/Ctrl-O`** — from any window, opens a file picker filtered to `.fcap`/`.fovea`. On macOS this is also **File → Open Recording…**.
- **Double-click a `.fcap` file** in Finder/Explorer, or drag it onto the app.

While the file loads, the window shows **Opening &lt;filename&gt;…**. If it cannot be read, the window shows the error message instead.

The title bar shows the file name and a compact path (your home folder shown as `~`). Two title-bar buttons are available once a file is open:

- **Open folder** — reveals the recording in Finder/Explorer.
- **Reset UI state** — re-runs the automatic layout, discarding your current arrangement (see [Layout persistence](#layout-persistence)).

---

## The preview panel (top)

The upper panel shows one **tile** per enabled stream whose block spans the current playhead time. Tiles are drawn in **Z-order** — the master track first, then top-to-bottom through the timeline tracks — so the arrangement of your tracks controls which view sits where.

The panel header shows the number of views, an optional **no wide designation** warning (see below), and a **tile** width slider.

- If a tile's stream has no decoded frame yet at the playhead, the tile shows **no frame** until you play or scrub onto a frame.
- If nothing is enabled under the playhead, the panel shows **No enabled stream under the playhead — press play or scrub.**

### Master / wide stream

If the recorder marked a wide/center stream, it becomes the **master** and its tile leads. If none was designated, the Viewer uses the first stream as master and shows a **no wide designation** hint in the header — playback is unaffected, only the ordering is a best guess.

### Tile width

Drag the **tile** slider in the header to make all tiles wider or narrower. Tiles keep a fixed width and scroll horizontally rather than reflowing, so changing frame content never shifts your layout.

### 3D View (stereo pairs)

When the recording contains a left/right pair, the pair's left block carries a **3D View** dropdown (also reachable on the block in the timeline). Choose:

- **disabled** — show left and right as two separate tiles.
- **left-only** / **right-only** — collapse the pair to a single eye.
- **anaglyph** — merge the pair into one red/cyan 3D tile (view through red/cyan glasses).

---

## The timeline panel (bottom)

The lower panel is a read-only editor of **tracks** (rows) and **blocks** (the time span each stream covers). Row 0 is labelled **master**; the rest are numbered. A vertical line marks the playhead.

### Playback controls

The transport row at the top of the timeline has:

- **▶ / ⏸** — play or pause.
- A **rate** dropdown — `0.25×` to `4×`.
- The current time and total duration, as `m:ss.mmm`.
- A **scrub** slider spanning the whole recording.

You can also click anywhere on a track lane to seek the playhead to that point.

### Rearranging tracks

Drag a block up or down onto another lane to move its stream between tracks; because tile order follows track order, this is how you re-stack the previews. A drop is refused (the block snaps back) if it would collide with another block already occupying that time on the target lane. Drag a block below the last lane, onto the **＋ new track** zone, to give it a track of its own. Valid drop targets highlight; invalid ones show red.

### Focusing and disabling a stream

Click a block to focus it (it gets an outline). With a block focused, press **`v`** to disable that stream: it is hidden from the previews and dimmed in the timeline. Press **`v`** again to re-enable it. Disabling streams you are not reviewing keeps the preview panel uncluttered and reduces decode work.

### Descriptor overlays

For a multi-fovea recording, the master/center tile draws colored target boxes over the frame at each moment, one color per fovea target — the same targets you were tracking when you recorded.

---

## Resizing the panels

A **divider** sits between the preview and timeline panels. Drag it up or down to change the split; the preview keeps a minimum height. Drag (or collapse) it all the way down and the timeline folds into a thin **▲ timeline** drawer at the bottom — click the drawer to bring the timeline back. Use the **▼** button in the transport row to collapse it directly.

---

## Layout persistence

Everything about how you arranged the Viewer — track layout, disabled streams, 3D View modes, the preview/timeline split, tile width, and the playhead position — is saved to a **layout sidecar** (`<recording>.fcap.ui.json`) right next to the recording. Reopen the file later and your arrangement comes back. The recording file itself is never touched.

Two situations prompt you before anything is overwritten:

- **View layout unreadable** — the sidecar is present but corrupt. The Viewer opens with a fresh default layout and asks whether to **Reset** it (overwrite with the fresh layout) or **Not now** (leave the corrupt file untouched for this session).
- **Streams changed** — the recording's streams no longer match your saved layout. The Viewer merges what it can and asks whether to **Reset** to a fresh auto-packed layout or **Keep mine** (keep the merged layout and save it going forward).

The **Reset UI state** title-bar button re-runs the automatic layout at any time and saves it, discarding your current arrangement.

---

See also: [Recording and Capture](./recording-and-capture.md) for producing the `.fcap` files this window opens.
