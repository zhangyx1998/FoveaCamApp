# The gate suite

Every change lands **software-green** through these gates before commit.
Run them from `app/` (binaries live in the workspace root
`node_modules/.bin`).

| Gate | Command | Green means |
|---|---|---|
| Types | `vue-tsc --noEmit` | 0 errors. This is the routine check — do NOT run `vite build` on every iteration. |
| Tests | `vitest run` | All pass. Pure-logic modules (window manager, metering, graph derivation, codecs) are unit-tested with fakes/fake timers — no hardware in tests. |
| Bundles | `vite build` | Builds all window entries + `main`/`orchestrator`/`vision-worker` + both preloads. Reserve for natural checkpoints and bundle-boundary checks. |
| Process boundaries | `npm run check:boundaries` (from `app/`, or root) | Both invariants below hold. This script is the CANONICAL gate — it replaces the old by-hand greps with a TRANSITIVE import walk (a session importing `@lib`-that-imports-Vue is exactly the case a shallow grep missed). Exits non-zero, printing the import chain, on any breach. |
| ↳ Orchestrator zero-Vue | (part of the above) | No file reachable from `app/orchestrator/index.ts` or any module `session.ts` RUNTIME-imports `vue` — the process boundary holds (`architecture/processes.md` §2). |
| ↳ Renderer zero-core | (part of the above) | No file reachable from a renderer file (`.vue` + `app/src/**`) RUNTIME-imports the `core` addon; `import type` and the pure-types `core/types` module are fine, and the dev-only `modules/playground` is the one carve-out. |
| V11 triplet | preload bundles: one build per entry, CJS `.cjs`, no `createRequire(import.meta)` | Preloads boot (`architecture/processes.md` §4) |

## Environment notes

- Bare `node`/`npx` may be broken in the sandbox — use `/opt/homebrew/bin/node`
  for scripts; run gate binaries via `../node_modules/.bin/…` from `app/`.
- Working directories drift between shell invocations — always `cd` with
  absolute paths.
- Never run `tsc`/`vue-tsc --build` against `core/` — the native workspace
  has its own build (`core make build`); `core/dist/*.d.ts` are maintained
  by the core lane.
- Renderer-bundled npm libraries go in **devDependencies**
  (`architecture/processes.md` §5).
- UI look/behavior can only be finally verified live — ask for a rig/UI pass
  for anything visual (`verification-playbook.md`).

## Hardware gating vocabulary

- **RIG-GATED** — the change is code-complete but its observable effect needs
  the physical rig (live cameras/controller) to confirm.
- **RIG-VERIFY / Stage-F** — collected as the living checklist in
  `docs/hardware/stage-f.md`; take that doc to the rig.
