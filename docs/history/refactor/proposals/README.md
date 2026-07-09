# Refactor-era design briefs (archive)

Design briefs from the optimization/refactor rounds, kept for their
rationale; the systems they describe are landed and documented in
`docs/architecture/`:

- `converter-threads.md` — moving per-frame conversion into C++ brick
  threads (now `architecture/stream-graph.md`).
- `kill-jsview-loop.md` — removing the per-frame JS view relay.
- `node-graph.md` — the composed node-graph model.
- `docs-restructure.md` — the plan that produced today's docs layout.

The round's working artifacts (per-role survey proposals `A/B/C[-r2].md`
and the planner `TRIAGE.md`) were pruned in the 2026-07-09 docs cleanup;
they are retrievable from git history (last present at commit `086045d`).
