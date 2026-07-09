# Multi-fovea recording — raw 12p sensor streams + descriptor streams

Status: **RULED r2 — in execution** (user 2026-07-09, superseding the r1
tile-recording model the same day). Successor to
[capture-recorder-nodes](./capture-recorder-nodes.md) — reuses its recorder
thread node; r1's per-frame-dims pixel schema is DROPPED.

## The recording model (user ruling, verbatim intent)

A multi-fovea recording contains ONLY:

1. **Raw Bayer 12p-encoded sensor frames** — the wire payload, verbatim and
   packed, for each camera (left fovea / center wide / right fovea). NOT the
   unpacked 16-bit container, NOT BGRA tiles. Each frame binds its
   **dynamic parameters**: mirror location (voltages; live-snapshot now,
   FIN-averaged when v2 firmware lands — same `volt.source` provenance as
   capture-recorder ruling) and the dynamic undistortion/homography mapping
   for the fovea cameras (mirror-dependent, changes per frame).
2. **A global singleton camera matrix for the wide stream** — one metadata
   record (intrinsics + distortion) applying to every wide frame; the wide
   camera is static so nothing per-frame.
3. **Multi-fovea target streams as DESCRIPTORS, not pixels**: per target, a
   stream of `{timestamp, bbox on the wide frame, frame pointers}` where the
   pointers name the left/center/right raw frames (per-stream seq) that
   observation corresponds to. Fovea imagery is RECONSTRUCTED offline from
   the raw streams + per-frame dynamic params; it is never re-encoded.

Rationale: the raw streams already contain every pixel the rig saw — the
fovea cameras ARE the per-target imagery (the scheduler round-robins the
mirror across targets, so each L/R frame belongs to one target). Recording
composed tiles would duplicate pixels lossily; descriptors + params make the
container the complete, minimal, offline-reconstructable record.

## Rulings

1. **Packed 12p tap (core)**: `frame->raw` is the UNPACKED container (12p→16
   at Frame construction) — unusable here. New pre-Frame ArvBuffer tap in
   `core/lib/Aravis/RawPipe.cpp` (or sibling) publishing the verbatim wire
   payload to `camera/<serial>/raw12p` pipes: fixed dims, pixelFormat = the
   wire format (Bayer 12p when the sensor runs 12p readout), stride/packing
   documented in the pipe advert. Extract-before-release discipline applies
   at the ArvBuffer level (copy into the ring inside the stream callback).
2. **Dynamic streams** (kept from r1): recorder node `addStream`/
   `removeStream` mid-recording; MCAP channels register mid-file; removal =
   drain-the-tail (R-1 semantics); pipe-CLOSED is a normal stream end.
3. **Descriptor channels**: recorder gains data (non-frame) channels —
   `addDataStream(name)` + `postData(name, message)` from the session, one
   channel per live target (`fovea/<target-id>`), JSON-encoded
   `{tNs, bbox:{x,y,width,height}, frames:{left,center,right}}` with seq
   pointers. Channels churn with targets (ruling 2 machinery).
4. **Per-frame dynamic params** ride the existing extras path (telemetry
   channel, correlated by stream+seq — exact binding, never blocks writes):
   fovea streams answer `onFrame` with `{volts, H}`; the wide stream posts
   no per-frame extras (`extrasStreams` gating) — its camera matrix is the
   §2 global metadata record written once at start.
5. **Recorder stays a pure pipe consumer**; raw12p pipes are acquired via a
   refcount-shared `raw-pipe` helper (one advertise per id ever — kills the
   R-3 double-advertise class; manual-control recording/capture migrate onto
   it. Whether manual-control ALSO moves to packed 12p payloads is a
   follow-on ruling — the helper supports both payload kinds meanwhile).
6. **Viewer**: minimal playback support — unpack 12p→16 + debayer for
   display, descriptor channels surfaced as overlay data (bbox on wide).
   Channels appearing mid-file + per-stream ranges shorter than the
   container must work. Deep analysis tooling stays offline/Python (MCAP
   schema is the contract).
7. **UI**: record button in the multi-fovea drawer, Cmd-R via
   `onRecorderTrigger`, `recording:finished` → auto-open viewer.
8. **Interleaved execution**: I-1a (recorder: dynamic streams + data
   channels + raw12p schema + global metadata) ∥ I-1b (core: ArvBuffer tap →
   raw12p pipes) → R-1 (review/opt) → I-2 (session wiring: descriptors from
   the runtime/scheduler, params extras, refcounted raw pipes, UI, viewer
   playback) → R-2 (review/opt + churn soak end-to-end + docs/stage-f
   close).

## Gates

vue-tsc 0 / vitest / soaks / vite build at wave closes; core: `cd core &&
make` + hardware-free `core/test/NN-*.ts` set from repo ROOT. No Electron.
Rig items accumulate in `docs/hardware/stage-f.md` §"Multi-fovea recording"
(12p payload verbatim vs a reference wire capture, descriptor↔frame pairing
under live round-robin, offline reconstruction fidelity).
