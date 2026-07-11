# Value sweep — 2026-07-11 (multi-agent, adversarially verified)

Six dimension-scoped finders + six adversarial verifiers swept the tree at
`57fdd5b` for the issue classes this branch's session kept hitting (retention,
throughput headroom, silent failures, retired-pattern residue). 40 findings,
39 confirmed after refutation attempts, 1 refuted. Full per-finding evidence
lives in the planner transcript; this file records the FILTERED, planner-ranked
set. Status: **ALL FOUR TIERS RULED AND SHIPPED** (2026-07-11, lanes A-D: 53ba728, 0fc29e0, 0c16849 + the Lane C core commit; projection split view = separate proposal, Lane E).

## Tier 1 — correctness defects (fix first; several are recent-wave fallout)

| id | anchor | one-line | effort |
|---|---|---|---|
| dual-cmd-stream-handoff-race | controller-node.ts:433 | v2 attach races the JS fallback into a SECOND CMD_STREAM — firmware DAC is first-CREATE-wins, so one ordering parks the mirrors dead while every readout looks live; the benign ordering still leaves an FW5-violating orphan stream on every v2 activation. Wave-5 fallback design fault. | M |
| verge-integral-clamp-stale | disparity session.ts:999 | verge PID `integralLimits` aliases the construction-time `limits` array (baseline 200 default); the baseline resolve replaces `limits` with a NEW array — the integrator (which IS the command in velocity form) stays clamped to the wrong rig: halved near-field range or windup overshoot on any rig ≠ 200 mm. Two-site one-liner. | S |
| pipe-consumer-refcount-no-reconciliation | pipe-session.ts:178 | `connectPipe` refcounts record no channel/window owner; renderer reload/crash leaks the count permanently → consumer gate wedges ON, converter+camera burn full-rate forever with zero readers. Composed nodes got exactly this ledger; raw connects didn't. | M |
| portpipe-sink-throw-leaves-channel-open | PortPipe.h:288 | deliver()'s catch(...) exits the thread without closing the channel: a FIFO link then blocks the producer's fan-out INSIDE the stream mutex (whole-pipeline freeze + shutdown deadlock); latest/ring become silent black holes. One-line close-in-catch. | S |
| match-pair-join-no-staleness-bound | disparity session | L/R match join has no seq-gap/age cutoff — a stalled side freezes one eye's center into the vergence law indefinitely while status reads "tracking". | S |
| multifovea-lost-release-stale-scheduler | multi-fovea session | lost-tolerance release terminates the slot's MCU stream but never resyncs the round-robin scheduler — CMD_FRAMEs keep targeting the dead stream. | S |
| freeze-window-not-reset-on-activate | disparity session | freeze-window timestamps initialize at orchestrator START, never on activate — re-entry begins frozen under default thresholds. | S |
| v1-transient-error-clears-enabledByUs | controller-node.ts | one transient v1 actuate failure clears `enabledByUs` while the device stays enabled — disable-on-last-close contract silently broken. | S |

## Tier 2 — the feedback-loop bundle (all score-4; one coherent wave)

The system knows it's failing; the operator can't see it. Shared theme: the
A-P13 status-banner machinery exists and is bypassed.

| id | one-line | effort |
|---|---|---|
| controller-unplug-invisible | USB drop leaves `connected` telemetry green (probe timer swallows the exact rejection that signals it); mirrors silently stop steering. 2-line probe change. | S |
| streamview-stalled-reads-healthy | frozen stream keeps displaying last frame + last healthy FPS (meters only update on payload change); orchestrator already computes stall bins nobody renders. Add a 1 Hz staleness tick + STALLED badge. | S |
| activate-errors-bypass-banner | defineResourceSession routes activate() throws to console report() instead of s.fail() — five sessions show a dead black view on activation failure; the banner + retry-on-reactivate semantics already exist, unused. | S |
| fire-and-forget-rejections | 93 bare `session.call()` sites drop command rejections (3 have .catch) — "clicked and nothing happened" class. Fix once in useSession.call(): default rejection → status banner. | M |
| error-broadcast-dead-ends-in-console | everything diagnostics.report() carries (recorder failures, capture worker death, clock-cal failures, unhandledRejections) terminates at renderer console.error — invisible in a packaged app. Needs a small dismissible error tray fed by topic.error. | M |
| recording-finalize-truncation-reads-as-success | failed/deadline-aborted finalize publishes a normal stop, auto-opens the truncated container, returns true — operator learns at playback, after the rig is torn down. Surface FinalizeStats. | M |
| pipe-consumer-swallows-read-errors | renderer pipe consumer retries read errors forever, zero signal, known-bitten pattern. | S |

## Tier 3 — performance headroom

| id | one-line | effort |
|---|---|---|
| mat-convert-full-copy-per-vision-call | every JS↔native Vision call memcpys full input AND output (~500 MB/s pure copy on the display kernel alone; 4-6 round-trips/tick in the match loop at ~170 Hz) — the zero-copy MatView converter EXISTS with zero call sites. | M |
| frameview-putimagedata-main-thread | FrameView paints full-res synchronous putImageData on the Vue main thread per frame per view (8 MB/frame for a 300 px tile); createImageBitmap+drawImage keeps it GPU-side at display size. | M |
| frame-ref-dispose-strands-pool-buffer | frame refs never shm.release() the last displayed buffer on unmount; pool hwm ratchets forever; buckets become unevictable (outstanding never hits 0). Small dispose fix + windowed hwm. | S |
| ungated-diagnostic-heatmap | template-match diagnostic heatmap computed+copied+SHM-written every tick with no debugger open (emitHeatmap defaults true). | S/M |
| depth-view-legacy-stereobm | manual-control depth view still runs full-res StereoBM(0…64)+full reprojection in JS-adjacent kernels — duplicating (worse) what the tuned native stereo brick now does; also inherits the unsigned-window bug the scope just fixed. | M |
| parked-converter-buf-retention + vision-worker slice copy | idle-retention + redundant-copy small fry; bundle with the above. | S |

## Tier 4 — complexity & DX (bundle into a cleanup wave)

| id | one-line | effort |
|---|---|---|
| config-schema-hand-mirrored-4x | @lib/config is Vue-bound so FOUR orchestrator readers hand-mirror keys/unions/defaults/clamps ("keep in sync" comments); 600 Hz default exists in three places. Extract a Vue-free config-schema module (the docs/schema/anaglyph.js precedent). | M |
| compression-module-dead-lz4-required | core.Compression (LZ4) has zero callers anywhere; LZ4 is a REQUIRED build dep; AGENTS.md misstates it compresses frames. Drop module + dep. | S |
| native-seam-shadow-typing-dts-drift | five `as unknown as` shadow-interface casts bypass d.ts; Aravis d.ts missing 10 exports — the drift the hand-written-d.ts convention invites. | M |
| dead-code sweep | pipe-read-once.ts (0 callers, taught by two docs), sync.ts (unwired, pointed-at), app/lib residue (imgproc/abortable/swatch), ~20 unused exports, CORE_OBJECT_FEAT_STRICT_EQ. | S |
| boundary-gates-manual-grep-only | the two ruled process-boundary invariants are enforced by nobody-runs-them greps; make them a script the vitest/vue-tsc gate runs. | S |
| core-test-runner-undocumented | 47 numbered suites, stale ts-node shebang, tribal knowledge runner. Document + a tiny runner script. | S |
| codegen-junk-subpaths / registration-ritual / manage-data stub | smaller DX items; fold in opportunistically. | S |

## Refuted (recorded so it isn't re-found)

- ensure-stream-drops-updates-during-create: mechanism real (no flush of
  `latest` after lazy CREATE) but no live caller is a sparse pusher — every
  current session re-pushes within one pacer/rebase tick.

## Cross-references

- Device RX busy-spin (~100% core on idle fd) + native pending-map sweep:
  found by wave 6's worker, tracked separately (task #11) — not re-listed.
- Known/deferred items excluded by the sweep brief: session-name string
  typing, test-12 OpenCV gate, lockfile, electron-builder, stage-f rig items.
