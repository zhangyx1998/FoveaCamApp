# Manage Cameras

Manage Cameras is the utility where you set up the rig's cameras: see what is connected, assign each camera its role (left fovea, wide-angle center, or right fovea), and tune its exposure, gain, frame rate, and pixel format. Settings you change here are saved per camera and reused by every other app, so this is normally the first place you visit after connecting hardware.

**Prerequisites:** the cameras connected and powered. No calibration or MEMS controller is needed.

## What you see

Open **Manage Cameras** from the Welcome launcher (Utilities) or the **Apps** menu. The window shows one column per connected camera, side by side. Each column has a live preview at the top and, below it, the camera's controls. Cameras are discovered automatically when the app opens; the previews and readouts refresh continuously (about once a second).

If a camera is listed but held by another process, the app shows an error — **Camera <serial> is in use by another process.** Make sure no other app or tool is holding that camera, then reopen Manage Cameras to rescan.

Each control has a live readout next to its label, and its slider is disabled whenever the corresponding "auto" mode is on, so you always edit the value that is actually in effect.

## Controls

Every camera column offers the following, from top to bottom. Sliders that a given camera does not support are simply hidden.

### Role Assignment

The **Role Assignment** dropdown tells the rest of the app what this camera is:

- **[ NONE ]** — unassigned.
- **Fovea Left** — the left fovea camera.
- **Wide Angle** — the center, wide-angle camera.
- **Fovea Right** — the right fovea camera.

Roles are how the stereo and tracking apps know which camera is which, so assign them before using those apps.

### Pixel Format

When a camera exposes format options, the **Pixel Format** dropdown lets you choose its sensor readout format. As the hint under it explains: changing format briefly pauses the preview to reconfigure the camera, and 12-bit packed formats (for example `BayerRG12p`) read full sensor depth to cut debayer quantization noise. The dropdown is momentarily disabled while the switch is applied.

### Frame Rate

The **Frame Rate** fieldset has a mode dropdown — **Manual** or **Auto** — and a slider. In **Manual** mode the slider sets the frame rate (with the live value shown beside it); in **Auto** the camera free-runs and the slider is disabled.

### Exposure

The **Exposure** fieldset has a mode dropdown — **Manual**, **Auto (once)**, or **Auto (cont.)** — and a slider (scaled logarithmically, in microseconds). The slider is active only in **Manual**; the two auto modes let the camera set exposure itself (once, or continuously).

### Gain

The **Gain** fieldset works the same way: **Manual** / **Auto (once)** / **Auto (cont.)** and a slider (in dB), active only in **Manual**.

### Black Level

Where supported, the **Black Level** fieldset offers the same **Manual** / **Auto (once)** / **Auto (cont.)** modes and a slider.

### Reset Config

**Reset Config** returns the camera to automatic defaults — frame rate back to auto, each auto control set to run once, the role cleared — and erases that camera's saved configuration.

## Typical tasks

### To identify which physical camera is which

1. Open **Manage Cameras**.
2. Watch the previews and, if needed, wave your hand or point at each camera in turn to see which column updates.
3. Note the serial and description shown on each preview.

### To assign camera roles

1. In each camera's column, open the **Role Assignment** dropdown.
2. Choose **Fovea Left**, **Wide Angle**, or **Fovea Right** to match the physical camera.
3. Give the remaining cameras their roles. The choice is saved immediately and reused by the other apps.

### To tune exposure, gain, or frame rate

1. Set the control's mode dropdown to **Manual**.
2. Drag the slider until the preview and readout look right.
3. Repeat for other controls. Values are saved as you change them.

### To read full sensor bit depth

1. Open the **Pixel Format** dropdown.
2. Choose a 12-bit packed format (for example `BayerRG12p`).
3. Wait for the preview to resume after the brief reconfigure pause.

### To start a camera over

Click **Reset Config** in that camera's column to clear its role and return every control to auto defaults.

## Notes

- Changes here persist and are shared across all apps — you do not need to re-tune a camera each time you switch apps.
- There is no Record or Capture in this utility; the title-bar Record and Capture buttons stay disabled.

> **Data management (`manage-data`).** A `manage-data` module exists in the codebase but is an empty stub — it is not in the app launcher, the **Apps** menu, or any menu, and has no working screens. There is currently no in-app data-management view; recordings are opened through **File ▸ Open Recording…** (see [Getting Started](./getting-started.md#opening-a-recording) and [Viewer](./viewer.md)).
