# FoveaCam Duo documentation

FoveaCam Duo is a stereo MEMS-foveated camera rig running on Electron. This tree
holds the user manual and the developer reference for the app, the stream engine,
and the hardware.

| Tree | What it covers |
|---|---|
| [`manual/`](./manual/README.md) | **The user manual.** What each app window does and how to run the rig day to day — cameras, calibration, steering, tracking, recording, playback, settings. Start here. |
| [`spec/`](./spec/README.md) | Per-feature behavior specifications — the authoritative contract for each app and each core subsystem (streams, pipes, trackers, orchestrator protocol, viewer, calibration). |
| [`architecture/`](./architecture/README.md) | How the system fits together: processes, sessions, the stream node graph, windows, metering, the recorder, and the serial protocol. |
| [`hardware/`](./hardware/rig.md) | The physical rig — cameras, MEMS mirrors, the controller, and wiring. |
| [`design/`](./design/design-language.md) | The standing UI design language every window follows. |
| `schema/` | **Not prose docs** — a code-imported schema workspace. `pixel-formats.ts`, `anaglyph.ts`, and `fovea.ts` are imported by the app and generate the C++ header; the `codec/` vectors pin conformance tests. Do not move or rename. The [calibration record format](./schema/calibration-record.md) is documented here. |

The site is built with VitePress; the navbar and sidebar are generated
automatically from this tree by the config in `.vitepress/`. Run it locally
with `npm run docs:dev`.
