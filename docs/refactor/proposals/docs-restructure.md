# Docs restructure plan (A-37 — round-closer)

Planner-requested plan for the user directive: *"move docs out of refactor
folder and reword them as actual docs for developers."* **PLAN ONLY** — no
moves/renames until round close (B/C still log to `split-of-work.md` and the
refactor docs). Execution on planner signal, per the checklist in §4.

Two ground facts that shape everything below:

- **`docs/schema/` is not documentation.** It is a code-imported schema
  workspace: `pixel-formats.ts` is imported by `app/lib` + tests +
  `graph-contract.ts`, and `generate-pixel-formats.ts` emits the C++ header.
  It must **stay at its current path** (moving it is a code change with its own
  gates, out of scope for a docs round).
- **179 code-comment references** to `docs/refactor/...` exist across ~40
  files in `app/`, `core/`, `firmware/` (plus 4 in `AGENTS.md`) — mostly
  section citations like `docs/refactor/orchestrator.md §7.1 S4`. The
  checklist keeps every one of them truthful.

## 1. Inventory + disposition

Legend: **REWORD** = distill into a new developer doc (original archived) ·
**KEEP** = stays, light rewording in place · **ARCHIVE** = history, moved
verbatim to `docs/history/refactor/` · **SPLIT** = living spec extracted,
remainder archived.

### docs/refactor/*

| File | Lines | What it is | Disposition |
|---|---|---|---|
| `orchestrator.md` | 1192 | Master refactor plan + step log (Stages 1–5, invariants V1–V12) | **SPLIT** → living invariants + process/session architecture into `architecture/processes.md` + `architecture/sessions.md`; the stage log is history → archive |
| `refactor-plan.md` | 383 | Post-optimization sequencing plan (WS1–WS4, real-*) | **ARCHIVE** (sequencing is done when we execute; surviving directives distill into architecture docs) |
| `split-of-work.md` | ~1400+ | The work log (task dispatch + verification records) | **ARCHIVE** — explicitly history; the primary provenance record |
| `multi-window.md` | 194 | Window taxonomy/manager/manifest design (reqs 1–8) | **REWORD** → `architecture/windows.md` (taxonomy table, manager rules, state-in-URL, window identity `?win=`) |
| `workload-metering.md` | 79 | Meter abstraction design (observe-never-gate, snapshot schema) | **REWORD** → `architecture/metering.md` (merge the schema + C-18 max-interval + native ThreadMeter probes + profiler panels) |
| `recorder-container.md` | 196 | MCAP container format + viewer design; **schema contract pinned here** | **REWORD** → `architecture/recorder.md` — the format/schema section is a living spec (Python consumers depend on it); round history archived |
| `synced-capture.md` | 817 | Protocol v2 spec (CMD_STREAM/CMD_FRAME/FIN) + staging + firmware notes | **SPLIT** → protocol spec into `architecture/serial-protocol.md` (firmware + orchestrator devs need it, incl. FW5, two-phase semantics, FIN voltage binding); rounds/T-numbers archived |
| `async-reactive.md` | 268 | Store-ownership design (orchestrator store-hub), landed | **REWORD** (short) → fold into `architecture/sessions.md` §store; archive original |
| `stream-hot-path.md` | 60 | Early hot-path cleanup, flagged stale by planner 07-04 | **ARCHIVE** (superseded by WS1/pipes) |
| `verification-playbook.md` | 243 | HIL pass template (Pre-flight, PB1–PBn), PAUSED | **KEEP+REWORD** → `dev/verification-playbook.md`; regenerate the todo set post-refactor (the template structure is the value) |
| `hil-findings.md` | 61 | 2026-07-07 rig findings | **ARCHIVE**; any still-open RIG-GATED items migrate to `hardware/stage-f.md` first |
| `typescript.md` | 49 | NodeNext/Electron import gotchas | **KEEP+REWORD** → `dev/typescript.md` |
| `preload-error.md` | 59 | Raw error transcript that produced the V11 preload invariants | **ARCHIVE**; the V11/V11b/V11c invariants themselves are load-bearing and land in `architecture/processes.md` §preloads |
| `planner.md` | 187 | Planner handover note (2026-07-06) | **ARCHIVE** |

### docs/refactor/proposals/*

| File | What it is | Disposition |
|---|---|---|
| `A.md` `B.md` `C.md` `A-r2.md` `B-r2.md` `C-r2.md` | Optimization survey submissions | **ARCHIVE** |
| `TRIAGE.md`, `README.md` | Survey triage + round record | **ARCHIVE** |
| `converter-threads.md` | real-1e design brief (executed) | **ARCHIVE** (content superseded by the stream-graph doc) |
| `kill-jsview-loop.md` | real-1f migration brief (executed) | **ARCHIVE** |
| `node-graph.md` | real-2 brief — **still driving active work** | **KEEP in place until real-2 lands**, then REWORD → `architecture/stream-graph.md` + archive |
| `docs-restructure.md` | this plan | **ARCHIVE** after execution |

### docs/applications/* and docs/schema/*

| Path | Disposition |
|---|---|
| `docs/applications/*` (11 files) | **KEEP as-is** — already the target shape (audited, present-tense per-app developer docs with Open-questions sections). Only change: refresh the README index if paths around it move. |
| `docs/schema/*` | **KEEP at current path, untouched** — code-imported workspace (see ground facts). Optionally add a README clarifying it is a schema package, not prose docs. |

## 2. Target structure

```
docs/
  README.md                     ← index of the tree (new, ~20 lines)
  architecture/
    README.md                   ← system overview + diagram; where to start
    processes.md                ← main / orchestrator utilityProcess / renderer
                                  windows / worker_threads / native threads;
                                  preload rules (V11 triplet); build entries
    sessions.md                 ← contract/session/hub model, resource scopes
                                  (defineResourceSession), store-hub, drain
    stream-graph.md             ← node-graph model: path-like ids, StreamType
                                  harness, SHM pipes/seqlock, converter +
                                  undistort + fovea bricks, compose protocol
    windows.md                  ← window taxonomy, manager, manifest restore,
                                  stable window identity (?win=)
    metering.md                 ← workload meters, native probes, profiler
                                  (incl. graph panel + SATURATED semantics)
    recorder.md                 ← .fovea MCAP container spec + viewer + Python
    serial-protocol.md          ← protocol v2: streams, CMD_FRAME/FIN, voltage
                                  binding, FW constraints (FW5), v1 compat
  applications/                 ← unchanged (already real)
  dev/
    gates.md                    ← the gate suite: vue-tsc, vitest, vite build,
                                  zero-Vue/zero-core boundaries, V11 triplet,
                                  environment notes (bare node broken, etc.)
    verification-playbook.md    ← HIL template, regenerated todos
    typescript.md               ← NodeNext/import gotchas
  hardware/
    rig.md                      ← cameras/serials, controller, GPIO cabling
                                  (CAM0 uncabled note), bench setup
    stage-f.md                  ← LIVING checklist of rig-gated items: 12-bit
                                  A/B, FIN exposure voltage, streaming-echo
                                  verify (predictVolts), Streams::snapshot/FW5,
                                  freeze-gone re-check
  history/
    refactor/                   ← the archive set from §1, moved verbatim
      README.md                 ← provenance note (branch, dates, what
                                  superseded each doc)
  schema/                       ← UNCHANGED (code-imported)
```

Justification: `architecture/` answers "how does this system work" (the
distillation of the refactor's WHY+HOW without the migration narrative);
`dev/` answers "how do I work on it" (gates/conventions — today that
knowledge lives only in split-of-work headers and planner briefs); `hardware/`
answers "what does the rig need / what is still unverified" (Stage-F items are
living requirements, not history — they must survive the archive); `history/`
keeps every decision recoverable without polluting the developer surface.

## 3. Rewording approach ("actual docs for developers")

- **Present tense, current architecture.** "The registry advertises
  `camera/<serial>/convert` pipes" — never "we will migrate / landed in
  round 3". Status banners, round logs, task ids (A-xx/B-xx/C-xx), and
  commit-hash citations are dropped (they live on in `history/`).
- **Rationale survives.** Every "why not the obvious alternative" paragraph
  (e.g. why ONE undistort thread, why meters never gate, why the id rides the
  URL) is the most valuable content — it moves, prominently.
- **Stable references to code.** Link file paths + exported symbols
  (`app/orchestrator/metering.ts` → `registerWorkload`), never line numbers or
  hashes. Each architecture doc opens with a "source of truth" block listing
  the primary files it describes, so drift is checkable by grep.
- **Living requirements preserved.** RIG-GATED / Stage-F / FW-constraint notes
  are requirements, not narrative — they collect in `hardware/stage-f.md`
  (checklist form, one line each with the code path it gates) and are ALSO
  referenced from the architecture doc that owns the mechanism.
- **Invariant naming kept.** V1–V12/FW5-style invariant ids are retained in the
  new docs (comments across `app/`+`core` cite them, e.g. "V11b"), with a
  glossary table in `architecture/README.md` mapping id → doc §.

## 4. Migration checklist (ordered so nothing breaks)

1. **Freeze** (planner signal): round closed; B/C stop appending to
   `split-of-work.md` / refactor docs; tree clean.
2. **Create `docs/history/refactor/`** and `git mv` the §1 ARCHIVE set
   verbatim (git mv preserves file history). Add the provenance README.
3. **Write the new docs** (`architecture/`, `dev/`, `hardware/`) distilled
   from the archived sources. This is authoring work — propose splitting
   per-doc across A/B/C by ownership (A: windows/metering/processes; B:
   serial-protocol/recorder/native halves of stream-graph; C: sessions/
   stream-graph compose half) with planner review per doc.
4. **Repoint the entry docs**: `AGENTS.md` (4 refs) + `CLAUDE.md` → new
   architecture/dev paths; refresh `docs/applications/README.md` and add
   `docs/README.md`.
5. **Code comments (179 refs, ~40 files):** mechanical rewrite
   `docs/refactor/` → `docs/history/refactor/` across `app/ core/ firmware/`
   in ONE commit (comments stay truthful — the cited §anchors still exist in
   the archived files). Then repoint load-bearing citations (V11, FW5,
   metering contract, window taxonomy) to the NEW architecture docs
   opportunistically as files are next touched — never as a bulk rewrite (the
   new docs' section anchors need to stabilize first).
6. **Do not touch** `docs/schema/` (code-imported) or
   `docs/applications/*.md` content.
7. **Gates:** vue-tsc 0 / vitest / vite build (nothing imports moved files —
   schema untouched — so these must pass unchanged); plus
   `grep -rn "docs/refactor" app core firmware AGENTS.md CLAUDE.md` returns
   ZERO rows (everything says `docs/history/refactor` or a new path).
8. **Hold-back:** `proposals/node-graph.md` stays in place until real-2
   lands (active brief); it is the LAST archive move, together with this file.
9. One commit per step (2/3/4+5 separable), planner verifies per step; the
   whole sequence is a no-op for runtime behavior.

## Open questions — RULED (planner, 2026-07-08)

- `dev/` vs `contributing/` → **`dev/`** (research-rig repo, not an OSS flow).
- `split-of-work.md` → **archived WHOLE** (append-log; per-round splitting
  destroys the interleaved cross-lane narrative). Whole file + provenance
  README.
- Stage-F list → **confirmation sweep at execution**: grep RIG-GATED +
  RIG-VERIFY across docs + recent commit messages when authoring
  `hardware/stage-f.md`; that doc is what the user takes to the rig.

## 5. Architecture-doc outlines (pre-drafted; authored at execution)

Skeletons for the five A-relevant docs — section headers + content notes +
source-of-truth blocks, so execution is mostly transcription. (B/C author
`serial-protocol.md`, `recorder.md` internals, and the compose half of
`stream-graph.md` per the §4.3 ownership split.)

### architecture/processes.md
> Source of truth: `app/electron/main.ts`, `app/orchestrator/index.ts`,
> `app/electron/preload-*.ts`, `app/vite.config.ts`, `core/Addon.cpp`.
1. **Process map** — Electron main · orchestrator `utilityProcess` (owns
   `core`/hardware; the ONLY Aravis process — per-process camera exclusivity) ·
   N renderer windows (core-free) · worker_threads (vision, recorder) ·
   free-running native threads (capture sinks, converters, undistort, KCF).
   One diagram.
2. **Boundaries (the two greps)** — orchestrator-reachable code is Vue-free;
   renderer is core-free (type-only imports allowed). Why: bundle discipline +
   process ownership.
3. **Ports & handshakes** — `orchestrator:connect` → `MessageChannelMain` pair;
   channel tagging with `windowId`; `window:drain` / `window:closed` control
   messages; store-hub attach.
4. **Preload rules (V11 triplet)** — one-build-per-entry (no sibling chunks in
   sandboxed preloads), CJS-as-`.cjs` (V11b), no `createRequire(import.meta)`
   in preloads (V11c). Invariant ids retained — code comments cite them.
5. **Build entries** — window HTML generated from the `@lib/windows` registry
   (`foveaWindowEntries`); electron entries: main / orchestrator /
   vision-worker; the externalization rule (`isExternal`, deps vs devDeps).

### architecture/stream-graph.md
> Source of truth: `app/lib/orchestrator/graph-contract.ts`,
> `app/orchestrator/graph-topology.ts`, `app/lib/orchestrator/pipe-contract.ts`,
> `core` Pipe/ConverterStream/UndistortStream, `app/orchestrator/vision-worker*`.
1. **Model** — nodes with path-like ids = output stream ids (`nodeId` is the
   single spelling authority); multi named inputs / one output; the StreamType
   typing harness; `win/<windowId>/...` composed namespaces vs shared bricks.
2. **Transports** — native / SHM pipe (seqlock ring, epoch reuse-safe ids,
   dynamic resize) / worker MessagePort / session channel / sink.
3. **Bricks** — camera source, converter (BGRA8 pipe), undistort (native remap
   built at attach), fovea crop (dynamic), KCF, detector, vision kernels.
   Physical-vs-id-nesting edge rule (fovea).
4. **Consumption** — `usePipeFrame` (renderer), one-shot reads, worker
   PipeInputs; consumer-gated production (park on zero refcount).
5. **Observability** — `graphTopology()` riding `PerfSnapshot.graph`; meters
   keyed by node id; the profiler graph panel (layout keyed on (id, epoch)
   membership; stats-only refreshes never re-layout).
6. **Composition protocol** (C authors) — compose/decompose, validation,
   close-teardown via `hub.onWindowClosed`.

### architecture/windows.md
> Source of truth: `app/lib/windows.ts`, `app/electron/window-manager.ts`,
> `app/electron/window-manifest.ts`, `app/src/windows/boot-entry.ts`.
1. **Taxonomy** — the `WINDOWS` table: welcome/app/profiler/projection/viewer/
   debug; singleton vs exclusive vs 0..N; the welcome rule; owner +
   onOwnerClose cascade|survive; preload kind + sandbox per class.
2. **Manager** — the spawn chokepoint, drain-aware app switching ("closed" =
   session-idle-drained), the toggle primitive, viewer per-file dedupe.
3. **Identity** — the `?win=` stable instance id: minting, URL threading,
   reload/restore survival, channel tagging, the close-teardown signal.
4. **State-in-URL** — `url-state.ts` conventions; what belongs in the URL.
5. **Manifest restore** — dev-restart flow, `planFromManifest` invariants.
6. **Entry generation** — registry-driven HTML + the `bootEntry` map
   (gitignored `app/windows/*.html`).

### architecture/metering.md
> Source of truth: `app/orchestrator/metering.ts`, `@lib/orchestrator/stats.ts`,
> `app/orchestrator/native-probes.ts`, `app/src/profiler/*`.
1. **Contract** — meters observe, never gate (every handle method a safe no-op
   post-dispose); registerWorkload / ingest / emit / drop / begin / end /
   measure.
2. **Snapshot schema** — `WorkloadSnapshot`, interval vs cumulative windows,
   the max-interval ring (10×1 s bins), drop-reason buckets.
3. **Native probes** — ThreadMeter → the same plain-data shape; the probe
   registry (`registerNativeProbe`); out-of-loop probing.
4. **Named meters** — `controller:<port>` serial packets, recorder/viewer,
   pipe-id-keyed native meters (naming = node id where pipe-backed).
5. **Profiler** — workload table (SATURATED ≥0.9 semantics), the graph panel,
   snapshot export; how to read a bottleneck (the registry:* saturation case
   study, one paragraph).

### architecture/recorder.md (A drafts the shell; B owns format internals)
> Source of truth: `app/orchestrator/recorder/*`,
> `app/orchestrator/stream-writer.ts`, the viewer session +
> `ViewerWindow.vue`, the Python sub-project.
1. **Container** — `.fovea` = MCAP; channel/schema layout (the pinned
   contract); frame + voltage + metadata binding
   (`volt.source: fin-averaged | live`).
2. **Write path** — worker thread, backpressure/drop accounting (metered).
3. **Viewer** — one window per file, replay session, seek/decode.
4. **Python** — reading `.fovea` offline; the schema-stability promise.

Execution note: these five plus B/C's docs land in §4 step 3; each PR-sized,
planner-reviewed per doc.
