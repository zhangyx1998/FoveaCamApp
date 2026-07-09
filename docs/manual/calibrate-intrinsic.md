# Intrinsic Calibration

Intrinsic calibration teaches one camera what its own lens does to the image — the focal length, optical center, and lens distortion. You point the camera at a known pattern (a checkerboard or a set of markers), capture it from several angles and distances, and the app solves for the lens model. The result is saved with that camera and is what every undistortion and triangulation step later relies on. This is the first calibration you run, and the **Center** (wide) camera in particular must be done before any of the mirror-geometry steps.

**Prerequisites:** A connected camera (see [Manage Cameras](./manage-cameras.md)). A physical target: a printed checkerboard, or an ArUco/AprilTag marker. No prior calibration is required — this is where calibration begins.

## The camera picker

The app opens on a list titled **Select a camera to calibrate**. Each connected camera shows its vendor and model, a **Serial** badge, and its role badge (Left / Center / Right) if one is assigned. Below that:

- If the camera is calibrated, you see **Calibrated @** with a timestamp, **FOV: X …°, Y …°**, and **RMS: … px** (the reprojection error of the stored solve — lower is better).
- If not, it reads **Camera not calibrated.**

Each row has three buttons: **Calibrate (Checker)**, **Calibrate (Marker)**, and **Reset**. The **Reset** button clears that camera's stored calibration and is disabled when there is nothing to clear. Pick **Calibrate (Checker)** for a printed checkerboard or **Calibrate (Marker)** for ArUco/AprilTag targets; both open the same live calibration view in the matching mode.

### To calibrate a camera with a checkerboard

1. In the picker, click **Calibrate (Checker)** on the camera you want.
2. The live view opens. A raw preview fills the left panel; the footnote reads **Detector @ N Hz**, telling you the detector is running and how fast it sees frames.
3. Set the board geometry under **Pattern Size**: type the number of inner corners across in the **W** field and down in the **H** field. The line updates to show how many corners are currently detected (**-> N corners**). This count must match `W × H` before a capture is meaningful.
4. Use the **Pattern Size (mm)** slider to size the checkerboard the app projects onto the rig's display, if you are calibrating against the projected board rather than a printed one. This only scales the projected squares; it does not change the corner-count math.
5. When the board is fully detected, green dots overlay every corner on the preview. Move the board to a new angle or distance and watch the dots track it.
6. Click **Capture** to freeze the current detection into a sample. **Capture** is disabled until a detection exists. Each capture appears as a thumbnail tile in the **Captured Records** panel on the right, with a running count in its heading.
7. Repeat across a spread of positions — tilt the board, move it to the corners of the frame, vary distance. More varied samples give a better solve.
8. When you have enough samples, click **Calibrate**. It is disabled until you have at least one record, and reads **Calibrating…** while it works.
9. After the solve, the left panel shows the new **FOV** and **Last Solve RMS … px**. Check the RMS is low (see below). The result is saved automatically to the camera's configuration.

### To calibrate a camera with markers

1. In the picker, click **Calibrate (Marker)**.
2. Choose the marker family under **Marker Dictionary** (for example `4X4_50`) to match the printed markers you are using.
3. Use the **Detector Downscale** slider (**1 / N**) to trade detection speed against resolution — a higher downscale finds markers faster on large frames.
4. Detected markers overlay as green dots. As with checker mode, click **Capture** for each pose (disabled until a detection exists), collect a varied set, then click **Calibrate**.

### Reviewing and removing samples

The **Captured Records (N)** panel shows every sample as a thumbnail of the actual grayscale image that was captured, so you can see what each one contains. Click a tile to remove that sample — the tile is labelled **Click to remove**. Records are cleared automatically if you change the pattern size or the sensor size mid-session, so set your pattern geometry before you start capturing.

### Reading the RMS quality number

**RMS** (root-mean-square reprojection error, in pixels) is the app's quality readout. It appears three ways: as **Last Solve RMS** in the live view right after a solve, as **RMS** on the camera's row in the picker, and it is stored with the calibration. A low RMS (well under a pixel is typical for a good solve) means the lens model fits the samples tightly. A high RMS means bad or too-few samples — remove any blurry or mis-detected records and capture more varied poses, then calibrate again.

## Capturing a single still

The titlebar record and capture controls work here too. `Cmd/Ctrl-R` (or the titlebar record button) records the selected camera's raw sensor stream, and the camera icon opens a single-stream still capture of the selected camera. These are ordinary captures of the raw sensor, independent of the calibration records described above. See [Single Capture](./single-capture.md) and [Recording and Capture](./recording-and-capture.md).

## What can go wrong

- **Capture is greyed out:** no pattern is currently detected. Check lighting, the pattern-size fields, and that the target is fully in frame — the corner/marker dots must be showing.
- **Calibrate is greyed out:** you have no captured records yet, or a solve is already running (**Calibrating…**).
- **High RMS after a solve:** samples are too few or too similar, or some are mis-detected. Remove suspect thumbnails and add more varied poses.

Next: [Extrinsic Calibration](./calibrate-extrinsic.md), which needs the Center camera's intrinsic calibration in place.
