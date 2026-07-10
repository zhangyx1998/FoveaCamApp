# Settings

The **Settings** window holds app-wide preferences and a per-rig manager for
stored calibration data. It is a single shared window — open it from anywhere and
you always get the same one.

It has two tabs, switched by the header at the top:

- **Global config** — app-wide preferences (below).
- **Device config** — everything scoped to one selected rig (an L / C / R
  camera *triple*): its nickname and per-triple overrides, its calibration
  records, and device import/export. See [Device config](#device-config).

## Opening it

- **`Cmd`+`,`** (macOS) / **`Ctrl`+`,`** (Windows/Linux) — the standard
  Preferences shortcut, from any window.
- **Settings…** in the application menu (the **FoveaCam Duo** menu on macOS, the
  **File** menu on Windows/Linux).
- The **Settings** button in the Welcome launcher's **Utilities** group.

A second open just focuses the window already up.

## Application settings

These write to the app's shared configuration, so an edit here shows up in every
open window that reads the same value. Where a setting takes effect immediately,
the hint under it says **Applies live**; where it is read once when an app
starts, the hint says so.

| Setting | What it does | When it applies |
|---|---|---|
| **Default save directory** | Base folder new captures and recordings default into (each app appends its own sub-folder). Leave it empty for automatic (an external drive if mounted, else `~/Downloads`). A red underline means the path isn't writable. | New save/record destinations opened after the change |
| **Recording compression** | How recordings store their raw camera streams: **None (raw)** writes the full uncompressed sensor data (the default), or **zlib (lossless)** compresses each frame with lossless zlib. zlib recordings play back in the Viewer exactly like raw ones — no format change on your side. | Recordings started after the change (running recordings keep their method) |
| **TeleCanvas mode / URL / port** | How the app casts its projection overlay to an external display — see [TeleCanvas](#telecanvas) below. | Live |
| **Calibration marker size** | Physical marker size, in millimetres, used by the calibration tools. | Live — a running **Extrinsic** or **Drift** window's marker-size slider moves with it |
| **Calibration marker ratio** | Inner/outer marker ratio for calibration. | Live |
| **Anaglyph style** | The left-eye / right-eye colors used for anaglyph 3D — pick one of four cards, see below. | Live — Disparity Scope's Anaglyph view and the recording Viewer's 3D mode |

### Anaglyph style

The **Anaglyph style** row shows four cards, each a split rectangle whose left
half is the color sent to the **left** eye and right half the color sent to the
**right** eye (the letters **L** / **R** mark the halves), with the option name
beneath:

| Card | Left eye | Right eye |
|---|---|---|
| **R/B** | Red | Blue |
| **R/C** | Red | Cyan *(default — the classic red/cyan glasses)* |
| **B/R** | Blue | Red |
| **C/R** | Cyan | Red *(mirror of the classic)* |

Click a card to select it — the chosen card gets an accent outline. The choice
applies live: Disparity Scope's center **Anaglyph** view retunes without a
restart and its option label updates to name the colors (e.g. *"Anaglyph (Blue
= Left, Red = Right)"*), and the recording **Viewer**'s 3D view recomposes on
its next frame. It is a view-time choice only — recordings are never changed.

The two marker fields are the same values the **Extrinsic** and **Drift**
calibration windows expose on their own sliders. Editing either place updates
the other while both are open — they share one setting.

> **Recording compression** applies to every app's record button. With **zlib**
> selected, recordings shrink losslessly. Note that lossless zlib may not keep up
> with full-rate 12-bit capture on all three cameras at once — if it can't, the
> recorder drops frames rather than stall, and those drops are reported in the
> record button's hover. Prefer **None** when you need every frame guaranteed.
> In **Tracking - Multi**, the per-stream compression checkboxes choose *which*
> of the three camera streams use the configured method; they are disabled while
> compression is set to **None**.

> The **stereo baseline** used to live here as an app-wide field. It is now a
> **per-triple** setting — expand a triple under **Calibration data** below.
> Rigs that never set it keep the previous 200 mm behaviour with no migration.

## TeleCanvas

**TeleCanvas** casts an app's projection overlay — the calibration markers and
other guides an app draws — to an external display so you can point it at a
physical target board, a TV, or a tablet. Open the dedicated **TeleCanvas**
window from any app's title bar (the television icon), or configure it here.
Both places edit the same settings and update live.

It has two **modes**:

- **Client** — the app **pushes** its projection to a **remote** TeleCanvas
  server you run elsewhere. Enter that server's address in **TeleCanvas server
  URL**; leave it empty to disable pushing. This is the default and matches the
  previous behaviour.
- **Host** — the app **serves its own** TeleCanvas viewer. Set a **TeleCanvas
  server port** (default **8100** — the reference project's default of 80 needs
  administrator rights, so a higher port is used). When it is running, one or
  more **reachable URLs** appear: `http://localhost:<port>/` plus one for each
  network address of this machine. Open any of them in a browser on a TV or
  tablet on the **same network** to see the live projection. Each URL has a copy
  button.

Whichever mode is active, the running app's windows keep pushing their
projection — switching mode only changes where that image goes. The **TeleCanvas
window's** own preview shows what the external display sees: in host mode it
mirrors the served image; in client mode it shows this window's local content
(the splash, since the live markers come from the app windows).

> The host server keeps only the most recent image in memory — a fresh app start
> begins from the splash. Any TeleCanvas-style pusher can also push to the host
> (an HTTP `PUT /` with the image as the body), so the host is a drop-in target
> for the same tools that push to a remote server.

## Device config

The **Device config** tab is scoped to one **triple** (an L / C / R camera set).
The first row is a **triple picker**: it opens a list of every configured rig,
with the currently-connected rig badged with a plug icon and selected by default.
You can also pick a rig that isn't plugged in to edit its stored settings.

### Nickname

Give the selected rig an optional **Nickname**. It shows in the triple picker
(above its camera serials) and in the **Welcome** window whenever that rig is the
one connected — a quick way to confirm you're on the bench you think you are.
Leave it empty to fall back to the camera serials.

### Per-triple settings

Below the nickname are the rig's overrides. Editing them never disturbs the
triple's drift correction.

**Zoom override.** Set it to the rig's known optical fovea↔wide zoom, or leave it
at **0** to use the value measured during calibration. Disparity Scope resolves
its **Auto** match zoom in the order *window zoom knob → this override → measured
magnification → 1*, so this drives Auto matching **on the next Disparity Scope
session start** — the window's own zoom knob still overrides it live.

**Baseline.** The physical stereo baseline, in millimetres. Empty = the app
default (shown inline as *app default: N mm*). Applies to Disparity Scope's
vergence limits **on the next session start**, and to the **Extrinsic / Drift /
Distortion** marker spacing **live**.

**Settle time** and **Delay compensation** are the Multi-Fovea trigger hold and
the Disparity Scope tracking-chain lead/lag; both apply on the next session start
(see their inline hints).

### Device settings: Export / Import / Clear

- **Export** writes this rig's settings (nickname, baseline, zoom, settle, delay)
  **and all its calibration records** to one JSON file. The records are attached
  with their rig associations stripped — the file describes the calibration data,
  not which bench it lived on.
- **Import** reads such a file back into the selected rig. Importing a config that
  came from a **different** triple asks you for a **new nickname** first. Each
  attached record whose calibration data already exists here simply gains an
  association to this rig (identical data is never duplicated); a record with new
  data is created.
- **Clear** resets this rig's settings to defaults after a confirm. Its
  calibration records are left untouched.

### Calibration records

Below the settings is the **Calibration records** list for the selected rig —
the extrinsic calibrations bound to it, **newest first**. Each row shows the
**datapoint count** and the **calibration time** (your local time), plus an eye
badge (**L** / **R**) and an *aggregate* tag for combined records.

Each row's buttons, left to right:

- **Overlay** (eye icon) — toggle this record as a live overlay on the
  calibration view (see [Visualizer & overlay](#visualizer-overlay)).
- **Inspect** (magnifier) — open the visualizer for this record.
- **Export** — write just this record to a JSON file.
- **Discard** (trash) — remove this rig's association with the record.

The **Import** button at the right end of the list title reads a record JSON file
into the selected rig (existing data → a new association; new data → a new
record).

**Aggregate.** Tick the checkboxes on two or more records and an **Aggregate**
button appears in the list title. It combines the selected records' datapoints
into a **new** record (with a fresh identity that notes its sources); the
originals are left as they are.

**Discard is refcounted — nothing is hard-deleted.** A record can be associated
with several rigs. **Discard** removes only *this* rig's association; the record
stays for its other rigs. When you discard the **last** association, the record
file moves to the **OS trash** (Finder / Explorer), so it is always recoverable.
The confirm prompt tells you which case applies.

> A running app keeps the calibration it loaded when it started, so discarding or
> aggregating records only affects the next time that app (or session) starts.

### Visualizer & overlay

**Inspect** opens the extrinsic **visualizer** — a virtual view (no camera feed)
that draws, for every recorded datapoint, the **observed** marker corners as
**dots** against the calibration solve's **projected** corners as **crosses**,
joined by a short error segment. The tighter the crosses sit on the dots, the
better the fit; the legend shows the overall **RMS** error (in pixels) and the
datapoint count.

From the inspector — or the eye icon on a list row — you can toggle the record as
a live **overlay**. When on, the same observed-vs-projected marks are drawn
directly over the matching eye's stream in a running **Extrinsic** calibration
window, so you can compare the stored calibration against the live scene. The
toggle is a shared, live setting: flip it in Settings and it appears on the
calibration window immediately (and flips off the same way).

### Legacy calibration inventory

The **Calibration data** inventory lower down still lists stored **Triple** and
**Intrinsic** documents with a friendly name and one-line summary, and a trash
button (with a **Confirm delete** / **Cancel** step) for removing an orphaned
one. Use the refresh button in its header after calibrating in another window.

For the design rationale and the on-disk record format, see the
[calibration-records-v2 proposal](../proposals/calibration-records-v2.md) and its
[format spec](../schema/calibration-record.md).
