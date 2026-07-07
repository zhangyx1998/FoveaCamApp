#!/usr/bin/env bash
# Dispatch a refactor coder (Codex, headless) — planner-triggered.
#
# Usage: scripts/dispatch-worker.sh <A|B|C> ["planner note for this run"]
#
# First run per role starts a fresh Codex session with the full kickoff
# prompt and records its session id; later runs `codex exec resume` the
# same session with a short re-entry prompt, so the worker keeps its
# warmed-up context across iterations (user preference — cold starts are
# costly in time and tokens). To retire a role's session and force a
# fresh start (e.g. at a stage boundary, to cap context growth), delete
# .worker-logs/session-<role>.id.
#
# Sandbox: workspace-write — repo-confined writes, no network. All gate
# tooling (npx / vue-tsc / vitest / vite build / core make build) runs
# inside the sandbox; `npm install` is intentionally impossible.
set -euo pipefail

role="${1:?usage: dispatch-worker.sh <A|B|C> [note]}"
note="${2:-}"
case "$role" in A|B|C) ;; *) echo "role must be A, B, or C" >&2; exit 2;; esac

repo="$(cd "$(dirname "$0")/.." && pwd)"
logdir="$repo/.worker-logs"
mkdir -p "$logdir"
ts="$(date +%Y%m%dT%H%M%S)"
log="$logdir/worker-$role-$ts.log"
last="$logdir/worker-$role-$ts.last.md"
sessfile="$logdir/session-$role.id"

kickoff="You are Coder $role on the FoveaCamApp refactor (branch refactor/decouple-orchestrator).

Read AGENTS.md first, then docs/refactor/split-of-work.md — that file is
your ONLY dispatch/log interface. Find the \"Coder $role\" section and
execute your active instructions, nothing else. If your section contains
Steering: notes, address those before anything else.

Rules (binding; the file's Protocol section is authoritative):
- Implement only your active instructions, in order. \"held\"/\"standby\"
  items must not be started.
- Respect the file-ownership table. To touch a file you don't own,
  request it via a one-line note in your log — do not edit it.
- Other docs/refactor/*.md files are planner-only: read for design
  context when linked, never edit. Your logs go under your
  instruction's \"Log:\" slot in split-of-work.md, <= 15 lines each:
  what landed, gates run with actual results, deviations from spec,
  one-line notes for out-of-scope discoveries (log, don't fix).
- Run the standing gates before logging. npx and direct shell commands
  are permitted for type checking, builds, and test scripts.
- The tree is intentionally dirty with others' uncommitted work —
  never revert or reshuffle anything you didn't write. Never commit.
- When your active instructions are done and logged, stop."

reentry="Re-entering as Coder $role (same role, same rules as before).
Re-read your \"Coder $role\" section in docs/refactor/split-of-work.md:
address Steering: notes first, then any newly active instructions.
Log under each instruction's \"Log:\" slot as usual; standing gates
before logging; never commit; stop when done."

if [[ -n "$note" ]]; then
  kickoff+="

Planner note for this run: $note"
  reentry+="

Planner note for this run: $note"
fi

status=0
if [[ -s "$sessfile" ]]; then
  sid="$(cat "$sessfile")"
  echo "[dispatch] Coder $role → resume session $sid (log: $log)"
  # `resume` has no -C/-s flags: cwd comes from the shell, sandbox via -c.
  (cd "$repo" && codex exec resume "$sid" \
    -c 'sandbox_mode="workspace-write"' \
    -c 'model="gpt-5.5"' \
    -c 'model_reasoning_effort="high"' \
    -o "$last" \
    "$reentry") >"$log" 2>&1 || status=$?
  if [[ $status -ne 0 ]] && grep -qiE "no session|not found|no rollout" "$log"; then
    echo "[dispatch] session $sid unresumable — clearing $sessfile; re-run for a fresh start"
    rm -f "$sessfile"
  fi
else
  echo "[dispatch] Coder $role → fresh session (log: $log)"
  codex exec \
    -C "$repo" \
    -s workspace-write \
    -c 'model="gpt-5.5"' \
    -c 'model_reasoning_effort="high"' \
    -o "$last" \
    "$kickoff" >"$log" 2>&1 || status=$?
  sid="$(grep -m1 -E '^session id: ' "$log" | sed 's/^session id: //')"
  if [[ -n "$sid" ]]; then
    printf '%s' "$sid" >"$sessfile"
    echo "[dispatch] recorded session id $sid"
  else
    echo "[dispatch] WARNING: no session id found in log — next run will start fresh"
  fi
fi

echo "[dispatch] Coder $role exited with status $status"
echo "[dispatch] transcript: $log"
echo "[dispatch] final message: $last"
exit "$status"
