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
| [profiler-tabs-and-graph-polish](./profiler-tabs-and-graph-polish.md) | shipped; rig visual pass owed | profiler splits into 5 tabs; graph edges become face-normal cubic béziers; per-node busy rings + hover-popup detail |
| [native-port-pipe](./native-port-pipe.md) | shipped; rig owed | typed native ports + `out.pipe(in, {latest\|fifo\|ring})` → probeable Link; topology self-registration; kcf→imm off the JS boundary; compile-time TS harness |
| [native-compose-controller](./native-compose-controller.md) | shipped; rig owed | port-pipe phase 2: native ComposeStream + controller pos_in sink + native mirror-history ring — zero per-tick JS on the control path; Cleanup registry leak fix for crash-shaped exits |
| [serial-rate-governor](./serial-rate-governor.md) | shipped; rig owed | serial pressure stats (TIOCOUTQ/EAGAIN/ACK-RTT → profiler Control tab), AIMD sync-rate governor with fairness reserve, optional serial-latency term in the predictor lookahead (`serial_latency_comp`) |
| [firmware-sim-harness](./firmware-sim-harness.md) | shipped; Mac pass owed | real firmware TUs compiled host-side behind a HAL shim — pre-flash behavioral regression for the protocol (settle_time, REJ paths, FIN averaging) |
| [projection-split-view](./projection-split-view.md) | shipped; manual UI pass owed | dedicated projection icon; VSCode-style split panes; cross-window move/duplicate drag; freeze-on-close + grace rebind; `projection_auto_close` |
| [profiler-graph-handrolled](./profiler-graph-handrolled.md) | shipped; eyeball pass owed | cytoscape+dagre dropped for handrolled SVG NodeGraph component: Sugiyama-lite layout, scroll-pan/pinch-zoom-at-pointer with center-in-bbox clamp, viewportContent refit, live drag re-lay, marching-dash flow, configurable hover card (`profiler_hover_card`) |
| [manual-control-trigger-and-views](./manual-control-trigger-and-views.md) | shipped; rig owed | disparity-scope's Capture Mode trigger sync (shared `@lib/trigger-sync` core) + native center views (disparity/anaglyph/sgbm) ported to manual-control; legacy kernel diff/depth retired (`coerceView`) |
