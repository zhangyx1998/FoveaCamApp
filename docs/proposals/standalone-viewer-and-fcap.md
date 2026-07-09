# Standalone viewer + fcap — decoupled playback, 12p Bayer decode, rename

Status: **RULED (user 2026-07-09; awaiting dispatch)**. Supersedes the
viewer's orchestrator-session architecture (viewer-contract.ts +
`@orchestrator/sessions/viewer` + `@orchestrator/viewer/*`). One rig finding
(F3) folds in.

## Rulings (user, 2026-07-09)

1. **The viewer utility window does NOT interface with the orchestrator.**
   It imports `core` directly and maintains its own node graph (if any) or
   decodes directly. This is an explicit, scoped EXCEPTION to the
   no-core-import-from-renderer rule — the viewer is an offline utility
   over files, not a live-hardware surface; decoupling it from the
   orchestrator means playback survives orchestrator restarts (see
   [orchestrator-lifecycle-and-exit](./orchestrator-lifecycle-and-exit.md))
   and never competes with live control loops. Consequence: the `viewer`
   session, its pinned contract, the frame-transport republish
   (`fr:viewer:<fileId>:<channel>`) and the orchestrator-side
   reader/player/decoder move INTO the viewer window (reader + decode on a
   worker thread in the window's process; the window renders its own Mats
   — no SHM hop, no IPC frame path).
2. **File suffix `.fcap` replaces `.fovea`.** Recorder writes `.fcap`;
   dialogs/file-associations/auto-open accept both, `.fovea` as legacy
   read-only (planner default — cheap, keeps existing rig recordings
   openable; flag at dispatch if legacy support should be dropped).
3. **Python package: directory `pyfcap`, published as `fcap` (pending PyPI
   name availability — check at publish time; publishing itself stays
   user-gated), `import fcap`.** Today's `pyfovea` renames wholesale (its
   pyproject already marks the name a placeholder).

## Rig finding F3 — BayerRG12p striped decode

User (live rig): the viewer cannot decode a recorded BayerRG12p channel
(metadata `dtype=U16, significantBits=12, stride=2880`); frame views render
striped "like the initial shm problem".

What the metadata means: all fields are copied VERBATIM from the pipe
advert (recorder = format-agnostic socket). `stride` is **bytes per row on
the wire**: BayerRG12p packs 12 bits/px = 1.5 B/px → 2880 B/row ⇒ 1920 px
row width. `dtype=U16` is the *unpacked container* dtype from the
pixel-format registry — for a packed wire payload the transport dtype
should read `U8` (decode.ts's `warnOnSchemaDrift` flags exactly this), so
the advert is stamping the registry's decoded dtype instead of the
transport dtype. The registry itself has BayerRG12p correct (isPacked,
Bayer RG, 12 sig bits) and `createFrameDecoder` branches on `isPacked`
(ignoring the drifted dtype), so the stripe is downstream. Candidate
mechanisms for the lane, in order:

- the decoded RGB (3-channel) Mat crossing the frame transport / FrameView
  with a 4-channel or wrong-pitch assumption (classic stride shear);
- per-frame payload length vs `shape` mismatch (advert `bytesPerFrame`
  derived from the U16 dtype = 2·W·H while the wire frame is 1.5·W·H — the
  recorder's fallback `frameBytes` would then over-read; unpack still
  starts correctly, but any path trusting byte length to infer geometry
  shears);
- `unpack12p` ignoring `stride` (row-padded payloads) — NOT the case for
  2880 = 1920·1.5 exactly, but honor stride anyway for robustness.

Lane: fix the advert's transport dtype at the source (raw-pipe advert),
make decode stride-aware, and add a conformance test decoding a REAL rig
fixture (ask the user for one striped `.fovea`/`.fcap` sample — synthetic
data proved bit order already; this failure is only reachable with the real
advert chain). This lane lands WITH ruling 1's move (same code), not before.

## UX items (same program)

4. **Subtitle = compact path**, not just the file name: abbreviated path
   (`~`-collapsed), left-overflow ellipsized (`direction: rtl` trick or
   middle-truncation), full path on hover/tooltip.
5. **"Open folder" button** on the right side of the viewer title bar —
   reveals the current file in Finder/Explorer (`shell.showItemInFolder`).
6. **Cmd/Ctrl-O + File menu**: ALREADY EXISTS (`main.ts` A-11 — File→"Open
   Recording…", `CmdOrCtrl+O`, multi-select, one viewer per file). This
   lane verifies it fires from every window class on the rig, and extends
   the dialog filter + macOS `open-file` + Windows/Linux arg association to
   `fcap` (+ legacy `fovea`).

## Execution

One program, two waves: **W1** the standalone move (ruling 1) + F3 fix +
fcap extension (ruling 2) — core-adjacent, viewer-window worker thread,
electron main touches; **W2** pyfcap rename (ruling 3, mechanical) + UX 4–6.
The pinned viewer contract retires with ruling 1 (the "pinned" arbitration
note in viewer-contract.ts is void once both sides live in one process).
Stage-f: §"Multi-fovea recording"'s viewer-playback item re-verifies under
the standalone viewer; F3 fixture decode becomes a repo test, not a rig item.
