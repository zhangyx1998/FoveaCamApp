# Ruled proposals — the plan of record

Each file is one user-ruled program: the verbatim intent, the numbered
rulings, and (once landed) an **AS SHIPPED** section recording the commit
chain, deltas from the ruled design, and residuals. Docs are the plan —
workers implement against these files, and live-rig items accumulate in
[`hardware/stage-f.md`](../hardware/stage-f.md).

| Proposal | Status | What it ruled |
|---|---|---|
| [unified-time-and-topology](./unified-time-and-topology.md) | P1–P3 shipped; P4 rig/firmware-gated | one time authority: owner-thread clock calibration, trusted timestamps between nodes, the tap-transport + NodeReport topology contract |
| [controller-node-and-fifo-edges](./controller-node-and-fifo-edges.md) | shipped; rig owed | controller as a thread node, FIFO undistort edges with hwm reporting, drag = parallel follow |
| [pid-nodes-and-view-replumb](./pid-nodes-and-view-replumb.md) | shipped; rig owed | PID as composed nodes everywhere; every view at pipe rate; display-kernel relay deleted |
| [split-disparity-nodes](./split-disparity-nodes.md) | shipped; rig owed | monolithic disparity kernel → slice + scale + per-side template-match workers + pid join |
| [stereo-disparity-and-heatmap-nodes](./stereo-disparity-and-heatmap-nodes.md) | shipped; rig owed | StereoStream (first two-input brick) + HeatmapStream; SGBM/anaglyph center views |
| [composite-node-and-center-select-fix](./composite-node-and-center-select-fix.md) | shipped; rig owed | CompositeStream brick (anaglyph\|difference), DiffView deleted, center-select fix |
| [disparity-debugger-window](./disparity-debugger-window.md) | shipped; rig owed | inline debug views → module-owned debugger sub-window |
| [capture-recorder-nodes](./capture-recorder-nodes.md) | shipped; rig owed | capture + recorder as one-worker thread nodes over named raw FIFO pipes |
| [multi-fovea-recording](./multi-fovea-recording.md) | shipped; rig owed | recordings = raw 12p wire payloads + descriptor streams + global wide matrix; advert-verbatim recorder; `/codec` suffix |
| [pairing-nodes](./pairing-nodes.md) | shipped; rig owed | per-stage L/R PairStream joins anchored on FINs — trigger-only, tolerance once at root |
| [stereo-paired-inputs](./stereo-paired-inputs.md) | shipped; rig owed | migrate the SGBM join from latest-wins taps onto exposure pairs |
| [calibration-polish](./calibration-polish.md) | shipped; rig owed | post-migration calibration fixes (drift lock gate, projected checkerboard) + UX |
| [capture-recorder-everywhere](./capture-recorder-everywhere.md) | shipped; rig owed | capture/record in every app; capture-hang + recording-drop rig fixes |
| [standalone-viewer-and-fcap](./standalone-viewer-and-fcap.md) | shipped; UI pass owed | viewer decouples from the orchestrator (core-import exception); BayerRG12p fix; `.fcap`/pyfcap rename |
| [orchestrator-lifecycle-and-exit](./orchestrator-lifecycle-and-exit.md) | shipped (amended); runtime pass owed | audited exit sequence: watchdog for main-crash, darwin park, crash reports, ack-based clean/crash, window-first quit (persistent process per AMENDED ruling) |
| [viewer-timeline](./viewer-timeline.md) | shipped; UI pass owed | multi-track timeline viewer: master wide track, packed blocks, playhead preview tiles, 3D dropdown, sidecar UI state |
| [prediction-compose-node](./prediction-compose-node.md) | shipped; rig owed | IMM predictor → native free-running brick (rate+offset, always wired); pid stays at camera rate; new compose node feed-forwards volt deltas at `prediction_rate_hz` (global, default 600) |
| [sgbm-signed-range](./sgbm-signed-range.md) | shipped; rig owed | foveated gaze ⇒ signed disparity: both stereo attach sites get a fixed symmetric ±256 window |
| [stereo-throughput](./stereo-throughput.md) | shipped; rig owed | stereo matcher becomes a benchmark-selected strategy (scaled SGBM_3WAY / BM / +WLS) targeting ~60 fps CPU-only |
