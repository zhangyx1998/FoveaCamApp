# Manage Cameras

Manage Cameras is the utility where you set up the rig's cameras: see what is connected, assign each camera its role (left fovea, wide-angle center, or right fovea), and tune its exposure, gain, frame rate, and pixel format. Settings you change here are saved per camera and reused by every other app, so this is normally the first place you visit after connecting hardware.

**Prerequisites:** the cameras connected and powered. No calibration or MEMS controller is needed.

## What you see

Open **Manage Cameras** from the Welcome launcher (Utilities) or the **Apps** menu. The window shows one column per connected camera, side by side. Each column has a live preview at the top and, below it, the camera's controls in compact groups: each group is a small uppercase header row with the group's name on the left and its mode dropdown (or selector) on the right, and the group's slider directly below — no boxes around anything.

If a camera is listed but held by another process, the app shows an error — **Camera <serial> is in use by another process.** Make sure no other app or tool is holding that camera, then reopen Manage Cameras to rescan.

Each slider has a live readout on its right, and the slider is disabled (dimmed) whenever the corresponding "auto" mode is on, so you always edit the value that is actually in effect. While you drag, the knob follows your hand; the readout settles on the value the camera actually applied (the camera may clamp or quantize slightly).

**Click-to-type.** On any manual slider, click the readout value itself: it turns into a small input in the same spot. Type an exact number in the readout's units (FPS, ms, or dB) and press **Enter** (or click away) to apply; **Esc** cancels.

**Snap points.** Some sliders show small tick marks at their edges. While dragging with the mouse, the knob snaps exactly onto a tick when you get close (within about 0.5% of the slider's width); keyboard arrows are never snapped, so you can still fine-step past a tick.

## Controls

Every camera column offers the following, from top to bottom. Sliders that a given camera does not support are simply hidden.

### Role

The **Role** dropdown (in the group's header row) tells the rest of the app what this camera is:

- **[ NONE ]** — unassigned.
- **Fovea Left** — the left fovea camera.
- **Wide Angle** — the center, wide-angle camera.
- **Fovea Right** — the right fovea camera.

Roles are how the stereo and tracking apps know which camera is which, so assign them before using those apps.

### Pixel Format

When a camera exposes format options, the **Pixel Format** dropdown lets you choose its sensor readout format. As the hint under it explains: changing format briefly pauses the preview to reconfigure the camera, and 12-bit packed formats (for example `BayerRG12p`) read full sensor depth to cut debayer quantization noise. The dropdown is momentarily disabled while the switch is applied.

### Frame Rate

The **Frame Rate** group has a mode dropdown — **Manual** or **Auto** — and a slider. In **Manual** mode the slider sets the frame rate (with the live value shown beside it); in **Auto** the camera free-runs and the slider is disabled.

The slider carries snap ticks at **50, 60, 100, and 120 FPS** (those within the camera's range), so the common video and anti-flicker rates land exactly.

### Exposure

The **Exposure** group has a mode dropdown — **Manual**, **Auto (once)**, or **Auto (cont.)** — and a logarithmic slider (readout in ms). The slider is active only in **Manual**; the two auto modes let the camera set exposure itself (once, or continuously).

Snap ticks sit at the anti-flicker exposures — **1/50 s (20 ms), 1/60 s (≈16.67 ms), 1/100 s (10 ms), 1/120 s (≈8.33 ms)** — and at each round decade (0.1 ms, 1 ms, 10 ms, …) inside the camera's range. Exposing for exactly one mains half-period is what kills the rolling brightness bands under 50/60 Hz artificial light, and the ticks make those values land precisely. Click-to-type takes the value in **milliseconds**.

### Gain

The **Gain** group works the same way: **Manual** / **Auto (once)** / **Auto (cont.)** and a slider (in dB), active only in **Manual**.

### Black Level

Where supported, the **Black Level** group offers the same **Manual** / **Auto (once)** / **Auto (cont.)** modes and a slider.

### Reset Config

The red-outlined **Reset Config** button at the bottom of the column returns the camera to automatic defaults — frame rate back to auto, each auto control set to run once, the role cleared — and erases that camera's saved configuration.

## Typical tasks

### To identify which physical camera is which

1. Open **Manage Cameras**.
2. Watch the previews and, if needed, wave your hand or point at each camera in turn to see which column updates.
3. Note the serial and description shown on each preview.

### To assign camera roles

1. In each camera's column, open the **Role** dropdown.
2. Choose **Fovea Left**, **Wide Angle**, or **Fovea Right** to match the physical camera.
3. Give the remaining cameras their roles. The choice is saved immediately and reused by the other apps.

### To tune exposure, gain, or frame rate

1. Set the group's mode dropdown to **Manual**.
2. Drag the slider until the preview and readout look right, or click the readout and type an exact value.
3. Repeat for other controls. Values are saved as you change them.

### To eliminate light flicker

1. Set **Exposure** to **Manual**.
2. Drag the slider onto the tick matching your mains frequency: **20 ms (1/50 s)** or **16.67 ms (1/60 s)** for full rejection, **10 ms (1/100 s)** or **8.33 ms (1/120 s)** if you need a shorter exposure. The knob snaps onto the tick exactly.
3. If the frame rate also beats against the lighting, set **Frame Rate** to **Manual** and snap it to 50/60/100/120 FPS.

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
