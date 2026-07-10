# Settings

The **Settings** window holds app-wide preferences and a manager for stored
calibration data. It is a single shared window — open it from anywhere and you
always get the same one.

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
| **TeleCanvas server URL** | The address the RemoteCanvas overlay PUTs its projection image to. Leave empty to disable it. | Live |
| **Baseline distance** | The stereo baseline, in millimetres, that Disparity Scope seeds its vergence from. | Next Disparity Scope session |
| **Calibration marker size** | Physical marker size, in millimetres, used by the calibration tools. | Live — a running **Extrinsic** or **Drift** window's marker-size slider moves with it |
| **Calibration marker ratio** | Inner/outer marker ratio for calibration. | Live |

The two marker fields are the same values the **Extrinsic** and **Drift**
calibration windows expose on their own sliders. Editing either place updates
the other while both are open — they share one setting.

## Calibration data

The lower section lists every stored calibration document, grouped into
**Triple**, **Intrinsic**, and **Extrinsic**. Each row shows a friendly name and
a one-line summary (a triple's stored overrides; an intrinsic's view count, RMS
error and date; an extrinsic's sample count). Names resolve against the cameras
currently connected — a triple recorded on the connected rig shows its three
serials; one from a different or absent rig falls back to a short hash. Use the
refresh button in the section header if you've just calibrated in another window.

### Per-triple zoom override

Expand a **Triple** row (the chevron on its left) to reveal its **Zoom
override**. Set it to the rig's known optical fovea↔wide zoom for that triple, or
leave it at **0** to use the value measured during calibration. This is stored
per triple; editing it does not disturb that triple's drift correction.

> Note: the zoom override is **stored** here but not yet consumed by Disparity
> Scope's zoom resolution — that wiring lands in a later update.

### Deleting

The trash button on a row deletes that stored document. You must confirm:
**Confirm delete** / **Cancel**. Deletion is permanent.

Deleting data an app is currently using is allowed — a running app keeps the copy
it loaded when it started, so the delete only takes effect the next time that app
(or session) starts. This is called out in the confirm prompt.
