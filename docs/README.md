# FoveaCamApp documentation

| Tree | Answers |
|---|---|
| [`architecture/`](./architecture/README.md) | How the system works — processes, sessions, the stream node graph, windows, metering, recorder, serial protocol. Start at the README. |
| [`applications/`](./applications/README.md) | Per-application developer docs (audited): what each app does, its session/vision wiring, known nuances, open questions. |
| [`proposals/`](./proposals/README.md) | The plan of record — user-ruled programs with their AS-SHIPPED outcomes and residuals. Start at the README's status table. |
| [`dev/`](./dev/gates.md) | How to work on the repo — the gate suite, TypeScript gotchas, the hardware verification playbook. |
| [`hardware/`](./hardware/rig.md) | The rig itself, and [`stage-f.md`](./hardware/stage-f.md) — the living checklist of items that can only be verified on hardware. |
| [`history/`](./history/refactor/README.md) | The orchestrator-refactor decision trail, archived verbatim. Not current — see its README. |
| `schema/` | **Not prose docs** — a code-imported schema workspace (`pixel-formats.ts` is imported by `app/` and generates the C++ header). Do not move or rename. |
