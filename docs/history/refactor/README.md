# Refactor archive (provenance)

Historical record of the orchestrator-decoupling refactor, executed on branch
`refactor/decouple-orchestrator` (2026-06 → 2026-07-08) by a planner + three
coder lanes (A: app/windows/Electron shell · B: native core · C: orchestrator
model/sessions). Archived verbatim at round close (A-37,
`proposals/docs-restructure.md`) when the developer docs moved to
`docs/architecture/`, `docs/dev/`, and `docs/hardware/`.

Nothing here describes the CURRENT system authoritatively — read
`docs/architecture/` for that. These files preserve the decision trail:

| File | What it was | Superseded by |
|---|---|---|
| `orchestrator.md` | Master plan + stage log (Stages 1–5, invariants V1–V12) | `architecture/processes.md`, `architecture/sessions.md` |
| `refactor-plan.md` | Post-optimization sequencing (WS1–WS4, real-*) | executed; no successor |
| `split-of-work.md` | The task dispatch + verification log (whole-file archive, planner-ruled) | — (primary provenance) |
| `multi-window.md` | Window architecture design | `architecture/windows.md` |
| `workload-metering.md` | Meter abstraction design | `architecture/metering.md` |
| `recorder-container.md` | MCAP container + viewer design | `architecture/recorder.md` |
| `synced-capture.md` | Protocol v2 design + staging | `architecture/serial-protocol.md` |
| `async-reactive.md` | Store-ownership design | `architecture/sessions.md` §store |
| `stream-hot-path.md` | Early hot-path cleanup (stale by 07-04) | WS1 pipes (see `architecture/stream-graph.md`) |
| `hil-findings.md` | 2026-07-07 rig findings | open items → `hardware/stage-f.md` |
| `preload-error.md` | Raw transcript behind the V11 preload invariants | `architecture/processes.md` §preloads |
| `planner.md` | Planner handover note | — |
| `proposals/` | Optimization surveys + triage + design briefs (converter threads, JS-view-loop removal, node graph, this restructure) | `architecture/stream-graph.md` et al. |

Section citations in code comments of the form
`docs/history/refactor/<file> §<n>` refer to these archived files — the
anchors remain valid here. Invariant ids (V1–V12, FW5, …) cited in code are
defined in the new architecture docs (glossary: `architecture/README.md`).
