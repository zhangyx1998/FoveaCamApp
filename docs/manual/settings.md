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
| **TeleCanvas mode / URL / port** | How the app casts its projection overlay to an external display — see [TeleCanvas](#telecanvas) below. | Live |
| **Baseline distance** | The stereo baseline, in millimetres, that Disparity Scope seeds its vergence from. | Next Disparity Scope session |
| **Calibration marker size** | Physical marker size, in millimetres, used by the calibration tools. | Live — a running **Extrinsic** or **Drift** window's marker-size slider moves with it |
| **Calibration marker ratio** | Inner/outer marker ratio for calibration. | Live |

The two marker fields are the same values the **Extrinsic** and **Drift**
calibration windows expose on their own sliders. Editing either place updates
the other while both are open — they share one setting.

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
