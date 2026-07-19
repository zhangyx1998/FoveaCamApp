# Single Capture

Single Capture is the simplest app: pick one connected camera and watch its live view full-window. Use it to confirm a camera is streaming, to frame a shot, or to eyeball exposure and focus before moving to a working app. It is a viewer only — it does not itself save images or record (see [Where files come from](#where-files-come-from)).

**Prerequisites:** at least one camera connected. Roles and per-camera settings from [Manage Cameras](./manage-cameras.md) are applied automatically but are not required to view a stream.

## What you see

Open **Single Capture** from the Welcome launcher (Applications) or the **Apps** menu. The window shows one large live frame — titled **Camera View** — above a single control:

- A **Camera** dropdown. It starts on **Select a Camera** and lists every connected camera as `vendor model (serial)`.

Until you pick a camera the frame stays blank.

## Selecting a camera

1. Open the **Camera** dropdown.
2. Choose a camera from the list. The app opens it (restoring the settings you saved in Manage Cameras) and the live view begins in the **Camera View** area.

To switch cameras, pick a different entry; the previous stream is torn down and the new one starts. The choice is remembered, so re-opening Single Capture resumes the last camera you viewed.

If a camera was just released by another app it may take a few seconds to become available; the view fills in once the camera opens.

## Where files come from

Single Capture has no save or record controls of its own — the title-bar **Record** and **Capture** buttons stay disabled here. It is purely a live monitor. To save stills or record video, use an app that supports it (for example [Manual Control](./manual-control.md)) and see [Recording and Capture](./recording-and-capture.md) for where files land.
