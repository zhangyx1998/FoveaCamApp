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
| `multi-window.md` | Window architecture design | `architecture/windows.md` |
| `workload-metering.md` | Meter abstraction design | `architecture/metering.md` |
| `recorder-container.md` | MCAP container + viewer design | `architecture/recorder.md` |
| `synced-capture.md` | Protocol v2 design + staging | `architecture/serial-protocol.md` |
| `async-reactive.md` | Store-ownership design | `architecture/sessions.md` §store |
| `hil-findings.md` | 2026-07-07 rig findings | open items → `hardware/stage-f.md` |
| `preload-error.md` | Raw transcript behind the V11 preload invariants | `architecture/processes.md` §preloads |
| `proposals/` | Design briefs (converter threads, JS-view-loop removal, node graph, docs restructure) | `architecture/stream-graph.md` et al. |

Pure coordination logs were pruned in the 2026-07-09 docs cleanup — the
dispatch/verification ledger (`split-of-work.md`), the planner handover
(`planner.md`), the executed sequencing plan (`refactor-plan.md`), the stale
early hot-path note (`stream-hot-path.md`), and the optimization-survey round
artifacts (`proposals/{A,B,C}[-r2].md`, `proposals/TRIAGE.md`). All remain
retrievable from git history (last present at commit `086045d`).

Section citations in code comments of the form
`docs/history/refactor/<file> §<n>` refer to these archived files — the
anchors remain valid here. Invariant ids (V1–V12, FW5, …) cited in code are
defined in the new architecture docs (glossary: `architecture/README.md`).
