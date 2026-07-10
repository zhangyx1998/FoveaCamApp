# Getting Started

FoveaCam Duo is the desktop control application for the stereo/fovea camera rig. It runs as a single app with one window per task: a **Welcome** launcher and one **app window** at a time for whatever you are doing (managing cameras, capturing, tracking, calibrating). This chapter covers launching the app, the launcher, and the chrome every app window shares, so the per-app chapters can focus on their own controls.

**Prerequisites:** the rig cameras connected and powered. The MEMS controller and calibration data are only needed by specific apps (noted in their chapters).

## Launching the app

Start FoveaCam Duo the way you launch any desktop application. On first open you land on the **Welcome** window. The app keeps one launcher and, at most, one working app window open at a time — opening a second app closes down the first (see [Switching apps](#switching-apps)).

## The Welcome window

The Welcome window has two panes.

**Left — status.** The FoveaCam Duo logo fills the pane, with the live camera list and a status row below it. The Welcome window is **status-only** — it opens no cameras of its own, so entering an app is instant (there is nothing to release first). The camera list and status come from a small background process that only *enumerates* connected devices; it never opens a camera.

Along the bottom is the status row:

- A status dot and text. The text reads **connected — N cameras** (green dot) when cameras are found, or **no cameras** when none are detected. (There is no longer an "orchestrator down" state — the launcher does not depend on the working engine, which only exists while an app is open.)
- Above it, each detected camera is listed with its role (L / C / R, when assigned), vendor/model, and serial.
- When the connected cameras form a complete L / C / R triple that has a **nickname** set (in [Settings → Device config](settings.md#nickname)), that nickname is shown above the camera list — a quick confirmation of which bench you're on. It updates live if you edit the nickname while Welcome is open.

**Right — the launcher.** Buttons are grouped under three headings:

- **Applications** — the main working apps.
- **Calibration** — the four calibration routines.
- **Utilities** — **Manage Cameras** and **Settings**. (The performance **Profiler** opens from inside a running app — see its button in the [title bar](#title-bar) — because it binds to that app's live session.)

Click any button to open that app in its own window. The Welcome window reappears automatically whenever you close the working app window and no other app is open.

### App inventory

| App | Group | What it does |
|---|---|---|
| [Manage Cameras](./manage-cameras.md) | Utilities | Discover connected cameras, assign roles, and tune each camera's exposure, gain, frame rate, and pixel format. |
| [Single Capture](./single-capture.md) | Applications | Pick one camera and watch its live view. |
| [Manual Control](./manual-control.md) | Applications | Hand-drive the MEMS mirrors and foveate the scene manually. |
| [Tracking - Multi](./multi-fovea.md) | Applications | Multi-fovea tracking — follow several targets at once. |
| [Disparity Scope](./disparity-scope.md) | Applications | Stereo disparity / depth inspection. |
| [Intrinsic](./calibrate-intrinsic.md) | Calibration | Per-camera intrinsic (lens) calibration. |
| [Extrinsic](./calibrate-extrinsic.md) | Calibration | Mirror/stereo geometry calibration — fits the voltage↔angle model for each eye. |
| [Distortion](./calibrate-distortion.md) | Calibration | Validation view of fovea→wide alignment (inspection only — not lens distortion, despite the name). |
| [Drift](./calibrate-drift.md) | Calibration | MEMS drift calibration. |

See [Calibration overview](./calibration.md) for how the four calibration apps fit together.

## Shared window chrome

Every app window carries the same title bar and overlays.

### Title bar

The title bar shows **FoveaCam Duo** followed by the app's name (for example, `FoveaCam Duo - Manage Cameras`). Click the app title to go **back to Home** — this closes the current app window and brings back the Welcome launcher. The empty stretches of the bar are draggable for moving the window.

On the right side of the bar are these controls (present in every app, though some are inactive where an app does not support them):

- **Record** button — a circle outline. See [Recording](#recording).
- **Capture** button (camera icon, tooltip **Capture preview**) — opens or closes the app's capture-preview sub-window. It is greyed out and unclickable in apps that do not offer single-shot capture. See [Capture](#capture).
- **TeleCanvas** button (television icon, tooltip **Open TeleCanvas window**) — opens the **TeleCanvas** window, which casts the app's projection overlay (calibration markers and the like) to a secondary display, tablet, or TV. See [Settings › TeleCanvas](settings.md#telecanvas) for the two ways it can send that image (push to a remote server, or serve its own).
- **Profiler** button (chart icon, tooltip **Open profiler window**) — opens the performance diagnostics window.
- **Controller** indicator — shows whether the MEMS controller unit is connected (red when not). Click it to open the connect/disconnect panel.

### Spin-up Progress Monitor

When an app window first opens (or when a new session starts up), the working area is briefly covered by a dimmed overlay listing the start-up steps. Each step shows its state:

- **Pending** — dimmed, with an hourglass.
- **Active** — brighter, with a spinner.
- **Done** — green, with a checkmark.

The overlay clears itself once start-up finishes. If it lingers, hover over it: a **Dismiss (show the app)** button (×) appears in the top-right corner, letting you reveal the partially loaded app underneath. A fresh start-up re-shows the overlay even if you dismissed the previous one.

### Crash banner

If the background engine stops unexpectedly, a red banner appears near the bottom of the window reading, for example, **Orchestrator crashed (code N) — hardware parked by cleanup worker.** This means the cameras and MEMS have been safely parked. Click **Reopen app** to reload the window and reconnect. A clean, intentional shutdown does not show the banner.

The banner also carries a collapsed **Diagnostics** section (click to expand). It shows the last lines of the engine's output in a scrollable box and, when available, a **Log** and a **Dump** row — each a **Reveal in Finder** button that opens the saved crash log (or native minidump) in your file browser. These files live under the app's data folder (`crash-logs/` and `crash-dumps/`); attach them when reporting a problem.

### Recording

The **Record** button is active only in apps that support recording (it is disabled in Single Capture and Manage Cameras). To record:

1. Click the **Record** button. A **Select Recording Destination** panel opens.
2. Set the **save directory** (the field is pre-filled with a default) and the sequence name shown after the `/`. If the path is not writable or a file already exists there, the field outline turns red and **Start** stays disabled.
3. Click **Start** (or press Enter). The record button begins blinking red while recording.
4. While recording, hover over the blinking button to see a live per-stream table (published, written, fps, size, and dropped-frame counts).
5. Click the button again to stop.

`Cmd/Ctrl-R` starts or stops recording directly, using the current default destination without opening the panel. Recorded files are written as `.fcap` recordings; see [Recording and Capture](./recording-and-capture.md).

### Capture

Apps that support single-shot capture enable the **Capture** button (camera icon). Click it — or press `Cmd/Ctrl-S` — to toggle a separate capture-preview window where you review the shot and save it. See [Recording and Capture](./recording-and-capture.md). In apps without capture (for example Single Capture), the button is greyed out.

### Debugger sub-windows

Some apps open their own extra sub-window — for example, Disparity Scope's match-strip and correlation-heatmap **Debugger**. These sub-windows are owned by the app that opened them: they close automatically when you close that app window.

## Opening a recording

Press `Cmd/Ctrl-O`, or use **File ▸ Open Recording…**, to open a saved `.fcap` (or legacy `.fovea`) recording. Each file opens in its own standalone **Viewer** window, independent of any running app. Selecting several files opens one Viewer each; re-opening a file that is already open focuses its existing window. See [Viewer](./viewer.md).

## Menus

The application menu bar carries:

- **File ▸ Open Recording…** (`Cmd/Ctrl-O`) and **Close** (`Cmd/Ctrl-W`, closes the current window).
- **Edit** — standard editing commands.
- **View ▸ Toggle Full Screen**. The title bar stays visible in full screen.
- **Apps** — the same launcher entries as the Welcome window, grouped Applications / Calibration / Utilities, so you can switch apps without returning Home.
- **Window** — standard window commands.

## Switching apps

Only one working app window is open at a time, and **each app runs its own private engine** — opening an app starts a fresh engine for it; closing or switching away disposes that engine entirely. Opening another app (from the Welcome launcher or the **Apps** menu) safely drains the current app — releasing its cameras and disarming the MEMS — before switching. You never need to close an app manually first.

Because the new app's engine is a brand-new process, it can begin loading immediately while the previous one shuts down; it only waits to *acquire the cameras and MEMS* until the previous app has fully released them (the cameras are exclusive to one process at a time). If that hand-off takes a moment, the new app shows a **"waiting for previous session to release hardware…"** step in its spin-up progress so you can see why it is pausing.

The most important consequence: because a closing app is disposed with its whole process, **a teardown problem in one app can never wedge the launcher or the next app.** The Welcome window keeps responding no matter what the app you just left is doing on its way out.

## Quitting

Closing an app window returns you to the Welcome launcher — and disposes that app's engine (draining its sessions, releasing its cameras, and disarming the MEMS). Closing the last window behaves by platform:

- **On macOS**, the app stays running with its menu bar available. With no app window open there is no engine at all, so nothing is energized (only the enumerate-only background process is running, and it holds no hardware). Re-activating the app (from the Dock) brings the launcher back; opening an app starts a fresh engine on demand.
- **On Windows/Linux**, closing the last window quits the app.

On a full quit, every live app engine drains its sessions, releases cameras, and confirms the hardware is safely disarmed before exiting — even after a crash, a cleanup worker guarantees the MEMS and cameras never stay armed.
