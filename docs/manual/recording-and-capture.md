# Recording and Capture

Every FoveaCam app can **record** a continuous session to disk and **capture** a still shot of the current cameras. Recording streams live frames to a `.fcap` recording file for later review in the [Viewer](./viewer.md); capture freezes and stacks the current frames into images you save as PNG/JPG/BMP/TIFF. Both are driven from the title bar of whichever app you are in.

**Prerequisites:** an app with a live camera session (any of the control or calibrate apps — see [Getting Started](./getting-started.md)). Recording and capture share the cameras, so only one of them can run at a time per camera set (see [Exclusivity](#exclusivity)).

---

## Recording

The **Record** button is the hollow circle in the title bar, next to the camera icon. It is greyed out and unclickable in an app that has no recordable streams; where recording is available it lights up on hover.

### To start a recording

1. Click the **Record** button. A **Select Recording Destination** panel drops down from the top-right.
2. The panel shows a path as two fields separated by `/`: a **Save directory...** on the left and a short **sequence** name on the right. Both are pre-filled with a dated default; edit either.
3. If the directory is not writable, or a recording with that sequence name already exists, the path row outlines in red and **Start** is disabled. Change the directory or the sequence name until the red clears.
4. Click **Start** (green), or press `Enter`. The panel closes and the **Record** button turns red and blinks for the whole recording.

The sequence name auto-increments after each recording, so repeated takes land as `0001`, `0002`, and so on inside the same directory.

### To start or stop without the dialog

Press `Cmd/Ctrl-R`. In a recording-capable window this toggles recording immediately using the current save-directory and the next sequence number — no destination panel. Press it again to stop. In a window with no recording available it does nothing.

### To stop a recording

Click the blinking red **Record** button (or press `Cmd/Ctrl-R`). Recording stops and the button returns to its hollow idle state. If the recording finalized successfully, the [Viewer](./viewer.md) opens automatically on the new `.fcap` file — one Viewer window per file.

### Reading the recording stats

While recording, hover the blinking **Record** button. A small table appears, one row per stream, with these columns:

| Column | Meaning |
|---|---|
| **pub** | Frames the camera *published* to this stream (the total offered). |
| **wrote** | Frames actually written to the `.fcap` file. |
| **fps** | Current write rate. |
| **size** | Bytes written so far for this stream. |
| **drops** | Frames lost, shown as `-N (q…/r…)`. |

`pub` always equals `wrote` plus `drops` — the count is honest, so a climbing **drops** number means frames are genuinely not reaching disk. The two letters in the drops cell tell you *why*:

- **q** — *queue* drops: frames piled up faster than they could be handed off to the writer (the recorder's in-memory queue overflowed). This points at the writer or disk being momentarily too slow.
- **r** — *ring* drops: the reader fell behind the camera and the camera overwrote frames before they were read (the shared frame buffer lapped). This points at the source being faster than the recording pipeline can keep up.

A wide, full-rate, high-bit-depth stream can drop frames on purpose when the disk cannot keep up — some drops on such a stream are expected. If **drops** climbs steadily on every stream, stop, record fewer/lighter streams, or record to a faster disk.

### Where recordings land

Recordings are `.fcap` files. Unless you change the path, they go into a dated per-app folder under your default save location, named for the date-time and the app. The `.fcap` file is what the [Viewer](./viewer.md) opens.

### Compression

By default recordings store the raw sensor data uncompressed. The **Recording compression** setting (in [Settings](./settings.md)) can switch this to **zlib (lossless)**, which compresses every recorded camera stream losslessly — the file is smaller and the [Viewer](./viewer.md) opens it exactly the same way, with no quality loss and nothing extra to do on playback.

The method is read **when a recording starts**, so changing it applies to your *next* recording; a recording already running keeps the method it began with. Old recordings made before you changed the setting still open normally.

Lossless zlib is not free: at full-rate 12-bit capture on all three cameras it may not keep up, in which case the recorder drops frames rather than stall — watch the **drops** column in the record-button hover (see [Reading the recording stats](#reading-the-recording-stats)). When you need every frame guaranteed, record with compression set to **None**.

In [Tracking - Multi](./multi-fovea.md) you additionally get per-stream checkboxes (left / center / right) that pick *which* of the three camera streams use the configured method. They are disabled while **Recording compression** is **None** (nothing compresses); set it to **zlib** in Settings to enable them.

---

## Capture

Capture takes a single high-quality still — in a stereo/fovea app that is the left, right, and center frames stacked together; in a single-camera app (see below) it is one sensor image. Captures are held in memory until you save or discard them.

The **camera** icon in the title bar opens the **Capture preview** window; `Cmd/Ctrl-S` toggles the same window. The icon is disabled in apps that hold no capturable cameras.

### To take and save a capture

1. Click the title-bar **camera** icon (or press `Cmd/Ctrl-S`) to open the **Capture preview** window.
2. Click **Capture shot** (bottom-right of the window). While the shot is being taken the button reads **Capturing…**.
3. The window fills with the shot: a metadata list on the left (click any row to expand its detail) and preview images on the right — one tile per captured stream (left / right / center, or the single sensor).
4. In the **Save As** row at the top, set the **directory** and **sequence** name (same `/`-separated path fields as recording). An invalid or already-used path outlines red and disables **Save**.
5. Click **Save** (green). The images are written and the window closes. Click **Discard** (red) instead to throw the shot away and close the window.

Closing the **Capture preview** window at any time keeps the held shot on the server until your next capture, save, or discard — reopening the window shows it again.

### Single-camera apps

[Intrinsic Calibration](./calibrate-intrinsic.md) holds only one camera, so its capture is a single stacked sensor image rather than a left/right/center triple. The window and the Save/Discard flow are identical; there is just one preview tile. ([Manage Cameras](./manage-cameras.md) and [Single Capture](./single-capture.md) have no capture at all — their title-bar buttons stay disabled.)

### Uncalibrated (degraded) captures

Some apps hold the cameras but not the per-frame calibration needed to warp the fovea crops and slice the center. In those apps a capture still works, but it falls back to **raw stacks with no warp**: the left/right images are stacked straight from the sensors and the center is the full undistorted frame. The metadata list marks this — the affected streams carry `capture: raw-stack`, `wrap: none`, and a short note explaining why (for example, no undistort before extrinsic calibration). If you expect aligned fovea crops and instead see raw, un-warped frames, check the metadata for the `raw-stack` note — the shot is intentionally degraded, not broken.

### When a capture stalls

A capture grabs a short burst of fresh frames from each camera. If a camera's stream never delivers (for example a raw producer that did not restart after a prior recording released it), the capture no longer hangs the app: after about 10 seconds it fails and the window shows a red error naming exactly which stream stalled and how many frames each delivered, for example:

> capture burst timed out after 10000ms: center delivered 1/1, left delivered 0/5, right delivered 3/5

Here the **left** stream is the culprit (0 of 5 frames). The app stays responsive — click **Capture shot** to retry. If the same stream keeps stalling, return home and re-enter the app (or power-cycle that camera set) to re-establish the stream, then capture again.

One caveat: the red error appears when the shot was triggered from the **Capture preview** window's own **Capture shot** button. [Manual Control](./manual-control.md) fires captures from its in-app **Capture** / **Raster Capture** buttons instead, and a timeout there currently reports nothing — the preview just keeps waiting. If that happens, open the **Capture preview** window and retry from its **Capture shot** button to see the error.

---

## Exclusivity

Recording and capture both claim the raw camera streams, so **only one recording or one capture burst can run per camera set at a time — across every app**, not just the one you are in. If a recording is already active anywhere, starting a capture is refused with an inline error, and vice versa. Stop the active recording (or let the capture burst finish) before starting the other. This is why the **Record** button and **camera** icon can appear available yet refuse the action: another window already owns the cameras.

---

See also: [Manual Control](./manual-control.md), [Tracking - Multi](./multi-fovea.md), and [Viewer](./viewer.md) for reviewing what you recorded.
