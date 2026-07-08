# Manage Cameras

**Seed confidence: HIGH.**

## Purpose
Camera inventory + per-camera configuration + live raw preview. The entry point
for verifying rig cabling/formats before running any app.

## Pipeline (post-real-1e)
Single-camera session per selected serial (`activeSerial`); registry lease +
`camera:<serial>` pipe advertise/attach; preview-only → NO JS loop, NO vision
worker: the native converter thread produces BGRA8 into the pipe, renderer
binds `usePipeFrame`. Config writes go through `reconfigure` (pause-free now)
+ persisted per-serial config (applyStoredConfig on boot).

## UI & controls
Camera list w/ vendor/model/serial; per-camera: pixel format (incl. 12-bit
readout formats — preview-safe option filtering), exposure/gain/black-level
(+auto modes), frame rate, trigger config, GPIO/strobe features via
getFeature/setFeature; live preview w/ inspector overlay (StreamView metrics).

## Expected behavior
Preview at camera rate with ~0 orchestrator load; 12-bit formats render
correctly (significantBits down-scale in convertFrame); config changes apply
live and persist.

## Known/suspected issues
- (was: the 1-2s glitch + 12p purple stripes — both fixed and rig-confirmed)
- Verify preview-safe pixel-format filtering still matches what Frame.view can
  render after the converter refactor.

## Open questions (for the user)
(auditor fills)
