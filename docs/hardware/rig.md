# The rig

> Source of truth for constants: `app/lib/camera-config.ts`,
> `app/orchestrator/controller.ts`, `firmware/`.

## Cameras

Three GigE (Aravis) cameras: **L**/**R** foveal (behind the MEMS mirrors) and
**C** center wide. Roles map to serials in the camera config; the
orchestrator's registry leases them per-serial (Aravis is per-process
exclusive — `architecture/processes.md`).

- **Hardware triggering:** only L and R are cabled for hardware trigger. The
  center camera's CAM0 port is reserved on the controller board but no cable
  currently fits (camera-side connector size constraint) — recoverable with a
  slimmer cable. Until then C free-runs.
- **GPIO wiring (L/R):** ONLY the opto-isolated pins + opto-GND are
  physically cabled — the non-isolated lines float. On the FLIR line map
  that is **Line0** (opto input — the trigger) and **Line1** (opto output —
  the ExposureActive strobe), which is exactly what
  `@orchestrator/camera-trigger` programs by default; a non-isolated line
  name can never work on this rig. Note the opto input wants the MCU pulse
  within its voltage spec and adds µs-scale edge lag — irrelevant at the
  ms-scale pulse widths `pairTriggerBudget` derives.
- 12-bit readout formats are supported end-to-end in code (preview-safe
  option filtering); live A/B on the rig is a Stage-F item.

## MEMS controller

Serial device (USB); protocol in `architecture/serial-protocol.md`. v2
firmware adds position streams + synced frame capture (FIN carries the
exposure-averaged mirror voltage). `verifyVersion()` decides v1/v2 at
connect; v2-only surfaces are gated on `v2Capable`.

## Bench flow

Firmware flashing + bench verification precede rig sessions (PlatformIO,
`firmware/`). The HIL workflow: run the pre-flight + playbook passes
(`docs/dev/verification-playbook.md`), export profiler snapshots as the
baseline, and work through `stage-f.md`.
