# `.fcap` / `.fovea` file association (dev mode)

Double-clicking a recording in Finder opens it in the app — **without** ever
spawning a second Electron when one is already running (user ruling).

## The shim

`app/scripts/register-fcap-handler.sh` builds `~/Applications/FoveaCam Dev.app`,
an AppleScript droplet registered as the LaunchServices handler for `.fcap`
(UTI `app.foveacam.fcap`, Owner) and `.fovea` (`app.foveacam.fovea`, Alternate,
read-only legacy). The droplet just runs `Contents/Resources/forward.sh` with
the opened file paths.

Install (idempotent — re-run to rebuild):

```sh
app/scripts/register-fcap-handler.sh
```

`duti` sets the default handler automatically if present; otherwise the script
prints the one-time Finder → Get Info → Open with → Change All step.

## The notify path (no second instance)

`forward.sh` resolves the running app's socket
`~/Library/Application Support/fovea-cam-app/open-file.sock`:

- **Running instance** — the socket exists; `nc -U` writes the newline-delimited
  paths to it and exits. `open-file-server.ts` (main-owned listener, the FIRST
  `whenReady` step — the rest of the chain can take minutes on a rig) reassembles
  the lines and calls `openExternal`, which opens a viewer per recording.
  **Zero new processes.**
- **Connect failure / not running** — a detached helper boots the real dev stack
  (`npm run dev` from `<repo>/app`; the vite electron plugin owns
  `VITE_DEV_SERVER_URL` and spawning Electron, so argv cannot pass through it),
  then polls the socket for up to 120 s and delivers the paths over it. The repo
  path is baked into the forwarder at install time; stack output lands in
  `$TMPDIR/foveacam-dev-shim.log`. A bare launch (no args) just boots the stack.

Main's fresh-launch argv path (`process.argv` filtered by `isRecordingPath`)
also feeds `openExternal` — it is what a packaged build's file association uses;
the dev shim can't reach it through vite. `openExternal` is the single sink for
all sources — macOS `open-file`, the socket callback, and argv — so no path can
fork a duplicate Electron.

## Packaging

The packaged app will declare the same associations via electron-builder
`fileAssociations` and reuse the identical `open-file` / argv / `openExternal`
code paths. The socket listener stays harmless in production (it only ever opens
recordings this instance is asked to open), so no code changes are needed to
ship — only the dev shim is retired in favor of the real bundle's UTIs.
