# Viewer video export (per-stream, ffmpeg-driven)

**Status: CODE-COMPLETE (2026-07-10).** Per-stream video export for the
standalone `.fcap` viewer, driven by ffmpeg. Pure logic unit-tested; the ffmpeg
pipeline (incl. the undistort remap path) smoke-tested end-to-end against a real
`ffmpeg 8.1.2`. No rig needed — the viewer is orchestrator-free. UI paths land
under vue-tsc + vitest but were not driven in a live Electron window (no-Electron
constraint); a UI pass is owed.

## Where it lives (process ownership)

The standalone viewer is **core-free in the renderer**; its decode ENGINE runs in
a MAIN-owned `utilityProcess` (one per viewer window — renderers can't fork Node
workers, commit 51cda07). The export follows that seam:

- **Engine (`utilityProcess`, `app/src/viewer/worker.ts`)** owns the whole
  pipeline: ffmpeg discovery, the export queue, decode → normalize → pipe →
  ffmpeg, progress metering, and abort (SIGKILL + unlink). It already random-
  accesses frames and holds the core-backed decoders, so nothing new touches
  core and nothing crosses into the renderer.
- **Renderer (`ViewerWindow.vue` + `ExportDialog.vue` + `ExportTray.vue`)** is
  UI only: it sends export commands over the existing engine `MessagePort` and
  renders the `export-update` snapshots.
- **Main (`app/electron/main.ts`)** owns the two things only it can: the system
  **save dialog** (spec 8) and the window-**close abort intercept** (spec 11),
  plus the **live-session banner** broadcast (addendum).

## Option matrix (codec → container / pixfmt / alpha)

Pure data table in `app/src/viewer/export/codecs.ts` (unit-tested):

| Codec | Encoder | Container | Pixel formats | Alpha |
|---|---|---|---|---|
| ProRes | `prores_ks` | `.mov` | 422/422 HQ → `yuv422p10le`; 4444 → `yuva444p10le` | 4444 only |
| H.264 (x264) | `libx264` | `.mp4` | `yuv420p`, `yuv444p` | — |
| H.265 (x265) | `libx265` | `.mp4` | `yuv420p`, `yuv444p`, `yuv420p10le`, `yuv444p10le` | — |
| VP9 | `libvpx-vp9` | `.webm` | `yuv420p`, `yuva420p` | `yuva420p` |
| AV1 | `libsvtav1` | `.webm` | `yuv420p`, `yuv420p10le` | — (encoder has no alpha) |

ProRes pixfmt options are filtered by the selected profile (422/HQ show the
4:2:2 pixfmt; 4444 shows the alpha 4:4:4 pixfmt). `alphaSupported(codec, pixfmt)`
is the single source of truth for offering Transparency.

## Pipeline

Decoded Mats (the same core-backed decoder the player uses) → normalized to raw
`rgba` (`export/normalize.ts`, mirrors `FrameView.expandToRGBA`: 1ch→gray,
3ch→+opaque alpha, 4ch verbatim) → piped on ffmpeg stdin:

```
ffmpeg -y -f rawvideo -pix_fmt rgba -s WxH -r FPS -i -   \
       [-i xmap.pgm -i ymap.pgm -filter_complex "[0][1][2]remap=fill=<fill>[v]" -map "[v]"] \
       -an -c:v <encoder> <quality flags> -pix_fmt <out> -progress pipe:2 -nostats <out>
```

`buildFfmpegArgs` (`export/ffmpeg-args.ts`) is pure + unit-tested. Progress is
metered off the frames the engine feeds (deterministic), not by scraping ffmpeg;
`-progress pipe:2` is emitted but the frame-count meter drives the UI.

### FPS detection + normalization (spec 6/7)

`export/fps.ts` (pure, tested): `detectFps` = **median** of frame intervals
(drop-robust). Two normalization modes:

- **as-is** (default) — feed recorded frames sequentially at the target fps.
- **resample** — walk the decoded stream and emit a **uniform timeline**
  (`uniformTimeline`), **blending** the two straddling frames by temporal
  distance (`blendWeights` + `blendFrames`). Blending is pure TS on decoded RGBA
  **before** ffmpeg, so it's codec-agnostic.

### Undistort (spec 4) — metadata availability finding

Recordings embed a `fovea:wide-camera` metadata record (multi-fovea-recording
ruling 2): the **wide/center** camera's `camera_matrix` + `dist_coeffs`
(intrinsics + Brown-Conrady distortion), JSON-encoded in the MCAP string→string
map. Production keys come from `session.ts wideCameraMeta()`
(`camera_matrix`, `dist_coeffs`, `sensor_size`, …); the parser also tolerates the
`matrix`/`distortion` writer-test spellings.

- **Wide/center stream** → **undistort available** (default ON). We build the
  OpenCV `initUndistortRectifyMap` (identity rectification, forward Brown-Conrady
  per dest pixel) in pure TS (`export/undistort.ts`), write **16-bit PGM** X/Y
  maps to a temp dir, and drive ffmpeg's `remap` filter. Out-of-bounds source
  samples are marked with a fill sentinel → remap fills them (transparent when
  alpha is on, black otherwise).
- **Fovea (left/right) streams** → **disabled with a hint**. Their undistortion
  is a per-frame dynamic homography (not a static matrix), which the viewer does
  not reconstruct. The toggle explains why.
- **No calibration** → disabled with a hint.

### Transparency (spec 5)

Alpha is only selectable when the pixfmt carries alpha **and** undistort is on
(the OOB remap regions are the only thing alpha reveals). The remap `fill` is
`black@0.0` (transparent) when alpha is on, `black` otherwise; a non-alpha output
pixfmt drops the plane so OOB shows black. When undistort is off and the source
is opaque, transparency is a no-op and the checkbox is disabled with that reason.

## Queue / abort semantics (spec 10/11)

`export/queue.ts` (pure state machine, exhaustively tested):

- **Serial** (parallel OFF, default, persisted `export_parallel`) — at most one
  running; new requests queue and dispatch on completion.
- **Parallel** (ON) — every queued job dispatches immediately; flipping ON
  drains the backlog; flipping OFF never pauses a running job.
- **Abort** a running job → `aborted`, the engine SIGKILLs its ffmpeg and unlinks
  the partial output; a queued job → `aborted` without starting. `abortAll`
  reports the running ids to kill+unlink (window close).

**Window-close intercept** — the renderer tells main when its active-export
count crosses 0 (`viewer:exports-active`). Main intercepts the window `close`;
if exports are active it `preventDefault`s and asks the renderer to confirm
(`viewer:confirm-close`). Confirm → the renderer aborts all exports + calls
`confirmViewerClose`, which re-`close()`s past the intercept. The engine also
`abortAll`s on its own `close` as a backstop.

## Live-capture banner (addendum)

Main is the only process that knows both a viewer window and the per-app
hardware instances. It mirrors the `telecanvas:target` seed+push pattern:
`getAppSessionActive()` seeds, `onAppSessionActive` pushes on the registry's
`onHardwareAliveChange` edge. The banner state machine (`export/banner.ts`, pure
+ tested) is per-window, per-episode: dismiss hides it while the condition holds,
but a clear→set (app closes then a new session starts) re-arms it. The banner is
a flex child at the top of the window (pushes content down — layout-stable, no
overlay, instant). The export tray's hover report also shows a one-line note
while a session is active (no behavioral change to exports).

## ffmpeg discovery (spec 1)

`export/ffmpeg-detect.ts` (pure resolver + real wrapper): searches `PATH` **plus**
`/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` — because a Finder-
launched Electron app inherits launchd's minimal PATH. The absolute path is
resolved once in the engine and remembered for spawning; `ffmpegAvailable` rides
the `opened` payload so the dialog enables/hints correctly. Detection never runs
in the renderer.

## AS-BUILT notes / deferrals

- **Default fps in the dialog uses the O(1) summary rate** (`avgFps`,
  `(count-1)/span`), not a per-stream median-of-deltas scan — a full timestamp
  scan at dialog-open is too costly for large recordings. The median detector
  (`detectFps`) is implemented + tested and is used in the engine's resample
  path (where frames are walked anyway). The field is user-overridable. If exact
  median-at-open is wanted later, add an `export-detect-fps` engine command that
  samples a bounded prefix.
- **ProRes 4444 alpha** encodes as `yuva444p12le` (ffmpeg promotes 10→12 for the
  4444 profile) — the alpha plane is present (smoke-confirmed).
- **VP9 alpha** is stored as a secondary alpha stream in WebM; the primary shows
  `yuv420p` under ffprobe. Expected.
- **UI not driven in a live window** (no-Electron constraint) — vue-tsc + vitest
  are green; a manual UI/UX pass is owed before ship.
- **Progress** is frame-count based (we control the input); ffmpeg's own
  `-progress` is emitted but not parsed.

### UI/UX polish run 2026-07-10 (resolved the review's deferred items)

- **Overall progress is now monotonic.** `ExportQueue.overallProgress()` used to
  average only queued(0)+running jobs, dropping finished jobs from the
  denominator, so the headline % dipped as siblings completed (e.g. 50→25→50).
  Jobs now carry an **episode** id (bumped when a job enqueues into an idle
  queue); overall progress spans the *current episode* with terminal jobs held
  in the denominator at 1.0 — a finishing job can only raise the %. Returns
  `null` once the whole episode is idle (all terminal), so the tray badge clears.
  Retained prior-episode terminal rows (kept for the tray until *Clear finished*)
  no longer inflate a fresh run. Pinned by `viewer-export.test.ts` (monotonic
  across `complete()` + fresh-episode restart cases).
- **Export dialog uses the shared modal shell.** It dropped its bespoke
  `.scrim`/`.dialog` at z-index 50 for the viewer's `.modal-scrim`/`.modal`
  pattern at z-index 100 (same surface tokens; inputs darkened to `--bg-chrome`
  to stay recessed on the panel-alt surface). Wider form factor kept via
  `.export-modal`.
- **Escape dismisses every viewer overlay.** `ViewerWindow.onKeydown` resolves
  Escape topmost-first: confirm modals → export dialog → stats popover, ahead of
  the text-entry/modifier guards (so it fires from a focused field). Escape is
  strictly non-destructive: on the "exports in progress" close prompt it *keeps
  the window open* and never aborts a running export.
- **Transport shortcuts + readout.** Space toggles play/pause; ←/→ step the
  playhead (~1/30 s, Shift = 1 s). The play control is now a FontAwesome
  play/pause icon (matching the rest of the chrome) and the centre timecode shows
  **playhead / total**. Tooltips carry the shortcut hints; tiles/blocks gained
  discoverability titles; the empty-tile placeholder explains the wait.
- **Floating-panel language unified.** The export tray's hover report adopts the
  stats popover's elevated surface + 6px radius + shadow.

## Files

- Pure/testable: `app/src/viewer/export/{codecs,fps,undistort,queue,banner,ffmpeg-args,ffmpeg-detect,normalize,types}.ts`
- Engine: `app/src/viewer/export/runner.ts`, `worker.ts` (wiring), `source.ts`
  (`wideCameraMeta()`), `protocol.ts` (commands/events + `ffmpegAvailable` /
  `wideCalibrationAvailable`).
- Main: `app/electron/main.ts` (save dialog, close intercept, session broadcast),
  `bridge.ts` + `preload-bridge.ts` (channels), `lib/config.ts` (`export_parallel`).
- UI: `app/src/viewer/ExportDialog.vue`, `app/src/viewer/ExportTray.vue`,
  `ViewerWindow.vue` (banner + tray + dialog wiring), `windows/icons.ts`.
- Tests: `app/test/viewer-export.test.ts` (40).
- Manual: `docs/manual/viewer.md` (Exporting a stream to video).
