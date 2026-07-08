# Single Capture

**Seed confidence: LOW — corrected by auditor from code
(modules/single-capture/). The seed's "capture to disk / hardware trigger"
hypothesis was WRONG.**

## Purpose
Despite the module name, this is NOT a disk-capture tool. It is a **single-camera
live view** — the streaming-path validation slice. It exists to prove the
end-to-end frame path (utilityProcess → core acquisition → native converter →
`camera:<serial>` SHM pipe → renderer) works for one selected camera. The
session is literally named `liveview` (see `contract.ts`, `session.ts`); there
is no save button, no capture command, no trigger config, no metadata.

## Pipeline (post-real-1c)
Single-camera session (`state.serial`). `session.ts` (`liveViewSession`) leases
the one selected serial from the registry (`retryUntil(() => acquire(serial))`,
with a supersede check so a newer serial wins if selected mid-open). The
registry opens + applies the camera's stored config and fans a preview. The raw
BGRA8 preview rides the native `camera:<serial>` pipe; the renderer reads it via
`usePipeFrame`, NOT via `s.frame()`. No JS event-loop frame work, no vision
worker — pure preview.

Note: `contract.ts` still declares `frames: ["frame"]` and the doc-comments
mention publishing frames on a `frame` channel, but that path is dead —
real-1c moved the preview to the pipe. The declared frame channel is unused
legacy (harmless; see Open questions).

## UI & controls
`index.vue`: one `<select>` bound to `state.serial` (populated from
`telemetry.cameras`, refreshed on mount via the `refresh` command) plus a single
`FrameView` showing the live stream. `usePipeFrame(camera:<serial>)` →
`payloadToMat` → `FrameView :mat`. That's the entire surface.

## Expected behavior
Pick a camera → orchestrator leases + opens it (restoring persisted config) →
live frames render at camera rate with ~0 orchestrator load (native converter
feeds the pipe). Switching serial tears down the previous lease and opens the
new one. `activate()` resumes the previously-selected stream on window re-open;
`idle()` releases the lease (registry closes the camera if no other holder).

## Known/suspected issues
- The seed's hardware-trigger concern does NOT apply: this app never triggers
  or captures — it only leases + previews. No L/R-vs-center trigger distinction
  is exercised here.
- Lease contention: if the selected camera is held by another process, `acquire`
  retries with backoff and silently gives up (`if (!held) return;`) — unlike
  manage-cameras, `liveview` does NOT surface a "camera in use" error to the UI,
  so a contended camera just shows no frames. Minor UX gap (see Open questions).

## Open questions (for the user)
- The module is named `single-capture` but implements a live view (`liveview`
  session). Is the "capture to disk" feature intended to live here eventually
  (name is aspirational), or should the module be renamed to match `liveview`?
- `contract.ts`'s `frames: ["frame"]` channel and the `frame`-publishing
  comments in `session.ts`/`contract.ts` are now dead (preview moved to the
  pipe). Remove the dead channel + comments? (Left untouched — cosmetic, and
  `contract.ts` shape changes can ripple to the client.)
- Should a contended-camera lease failure surface a UI error here (as
  manage-cameras does via `s.fail`), or is silent-no-frames acceptable for a
  validation slice?
