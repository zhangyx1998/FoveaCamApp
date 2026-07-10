# Teardown hardening — destroyed-primitive races + native crash tracing

Status: **AS-SHIPPED (2026-07-10)**. Owner lane: core (Stream family) + one
orchestrator boot hook. Follows the ee6fc46 stream-close-deadlock fix.

## Incident (2026-07-09 22:47)

A long-running disparity-scope orchestrator (`hw-2`) was SIGTERM'd by an Electron
dev-watch restart mid-session. During the forced teardown, core aborted:

```
libc++abi: terminating due to uncaught exception of type
  std::__1::system_error: mutex lock failed: Invalid argument
Orchestrator instance hw-2 exited: 6
```

`EINVAL` from `std::mutex::lock` on macOS libc++ = locking a **destroyed**
`pthread_mutex_t`. No native stack was captured (macOS wrote no `.ips` for the
`utilityProcess`). Exit 6 correctly triggered the janitor (hardware parked) — an
invariant we must preserve. But a termination must **never abort**, and the same
race can bite a normal app close.

Three deliverables: (1) root-cause + fix the destroyed-mutex teardown race,
(2) audit the same class across core, (3) add native crash-site tracing so the
next fault is never a bare one-liner.

## Root cause (proven)

### The destroyed-mutex race — `Subscriber::close` vs `~Stream`

`core/lib/Stream/Stream.h`. Streams are the base of every brick (Converter,
Undistort, Fovea, KCF, Stereo, Composite, …); subscribers are the JS iterators
(`Sub::Queue`/`Sub::Latest`), `PipeOfferSubscriber`, `TapPublisher`. A subscriber
holds a **raw** `Stream<T>*` back-pointer in its state; the stream is owned by a
`shared_ptr`/`RefCount` elsewhere.

The ee6fc46 deadlock fix made `Subscriber::close(unsubscribe=true)` capture that
raw `stream` under the state guard, **release** the guard, then call
`stream->unsubscribe(this)` (which locks `stream->mutex`). Its safety argument
covered use-after-free of the *subscriber* by the fan-out, but **nothing kept the
`Stream` itself alive across the gap** between capturing the pointer and locking
its mutex.

The missing invariant: **a clean `shutdown()` never ejected its subscribers.**
Only `crash()` nulled subscribers' back-pointers (`__clear_subscribers__`). On a
clean shutdown the base thread just exits on `flag_terminate`, leaving every
subscriber pointing at a stream that is about to be freed. So the ordering that
"usually works" (subscribers destroyed before their stream — JS-iterator cleanup
LIFO, or a chained brick's `shared_ptr source_`) is only a convention; under a
forced teardown it inverts:

```
Thread A (owning brick drop / env cleanup):  ~Stream  →  frees `mutex`
Thread B (JS finalizer / other brick):       ~Subscriber → close(true)
                                                → captures live-looking stream*
                                                → stream->unsubscribe(this)
                                                → lock(FREED mutex) → EINVAL
                                                → thrown from noexcept ~Subscriber
                                                → std::terminate → exit 6
```

`core/test/38-stream-teardown-race.ts` reproduces the exact signature on the
pre-fix (HEAD) header: `std::terminate … mutex lock failed: Invalid argument`,
frame 0 = `~Subscriber`.

### A second teardown bug surfaced by the same test: lost-wakeup hang

With the destroyed-mutex race closed, the soak then wedged. `sample` of the hung
process:

```
Thread (destroyer):  RaceStream::~RaceStream → Stream::shutdown() → thread.join()   [blocked]
Thread (producer):   Stream::thread_main → wait_activate → condition_variable::wait [parked forever]
```

`shutdown()` set `flag_terminate` and called `unfreeze.notify_all()` **without
holding `mutex`**, while `wait_activate()` evaluates its predicate (which reads
`flag_terminate`) under `mutex` and then atomically unlocks+sleeps. The notify
could land in the gap after the parking thread read the flag as `false` but
before it blocked — a classic lost wakeup. The producer sleeps forever and the
`join()` in `shutdown()` never returns. **A hung teardown is as bad as an aborted
one**: the orchestrator never exits, so hardware stays armed (violates the
hardware-quiescence invariant). Pre-existing; the fan-out iterate path rarely
parks, so it hid until test 38's park storm exposed it.

## The ownership / lifetime rule shipped

Two moves in `core/lib/Stream/Stream.h`, both on the close/shutdown path only (no
per-frame hot-path cost, fan-out unchanged):

**1. Streams eject + drain before destruction.** `shutdown()` (called by every
derived destructor, after the thread join) now calls `eject_all_and_drain()`:
under `mutex`, null every remaining subscriber's back-pointer (`detach()`) and
clear the set; then spin-wait `closes_in_flight_ == 0`. `detach()` nulls the
back-pointer WITHOUT running derived close hooks (no dispatch — teardown-safe,
avoids calling into JS/N-API from an env-cleanup context).

**2. A close-in-flight gate.** `Subscriber::close(unsubscribe=true)` increments a
per-stream `std::atomic<int> closes_in_flight_` **while still holding the state
guard** (where the stream is provably alive — see below), releases the guard,
calls `unsubscribe`, then decrements. `shutdown()`'s drain refuses to return
(hence `~Stream` cannot free `mutex`) until the count reaches 0.

### Why it is race-free (LIFETIME ORDER, mirrored in the header comment)

- **The increment lands on a live stream.** To free itself a stream must first
  `detach()` every subscriber, each under *that subscriber's own state guard*. A
  `close()` that observes `stream != nullptr` while holding its state guard
  therefore proves the eject has not yet processed it — and since the eject needs
  that same guard, it is blocked behind us and cannot have advanced to free the
  stream. So `stream` is alive at the `closes_in_flight_++`.
- **The drain waits out the in-flight window.** Any `close()` that captured the
  pointer *before* the eject has already incremented (under its guard, before the
  eject could take that guard); the drain waits for its matching decrement after
  `unsubscribe` returns. Any `close()` arriving *after* the eject sees
  `stream == nullptr` and returns early — no increment, no `unsubscribe`.
- **Lock order preserved (no ee6fc46 regression).** `close()` still takes ONLY
  the state guard, then a lock-free atomic, then releases before reaching for
  `mutex`. `eject`/fan-out take `mutex` first, then each state guard — the same
  order, never the reverse. `core/test/36` still passes.
- **Lost-wakeup closed.** `shutdown()` now flips `flag_terminate` **under
  `mutex`**, serializing against `wait_activate()`'s predicate check, so the
  subsequent `notify_all` can never be lost.

## Audit (Task 2) — destroyed-sync-primitive-race class

Swept `core/lib` + `core/src` for every mutex/CV/thread owned by an object
destructed while other threads can still reach it.

| # | Site | Primitive | Destruct path | Racing accessor | Verdict |
|---|------|-----------|---------------|-----------------|---------|
| 1 | `Stream/Stream.h:46` `Stream::mutex` | mutex + CV + subscriber set | `shutdown()` → `~Stream` frees `mutex` | cross-thread `Subscriber::close`→`unsubscribe` on the raw back-pointer | **FIXED** — eject-all-and-drain + `closes_in_flight_` gate |
| 2 | `Stream/Stream.h:68` `shutdown()` notify | CV `unfreeze` | `flag_terminate`+`notify_all` outside `mutex` vs `wait_activate` park | own producer thread parking | **FIXED** — flip `flag_terminate` under `mutex` |
| 3 | `Stream/Stream.h` (all bricks: Converter/Undistort/Fovea/Scale/Stereo/Heatmap/Composite/Pair/KCF/MultiKCF) | inherited from Stream | each `~Brick` calls `shutdown()` (+ `closeChain()` for chained) | any subscriber close | **FIXED transitively** — one base fix covers every brick; each already asserts `shutdown()` was called |
| 4 | `Aravis/ClockCalibration.h:152` `ClockCalibrator::thread_` (+ `const Camera&`) | own `m_`/`cv_` (joined in `~ClockCalibrator`, SAFE) | the thread runs `calibrateCameraClock` touching the `ArvCamera` / global glib bus | camera enumeration/teardown with MULTIPLE per-camera calibrator threads (fake-camera `Camera.list()` path) | **SUSPECT (documented, not fixed)** — see below |
| 5 | `Aravis/CompressStream.cpp:158` `thread_` | own state | dtor closes the tap FIRST (wakes blocked `poll` → EOS), THEN joins; source held by `shared_ptr` | downstream close / source death | **SAFE** — same close-to-wake-then-join discipline as `ChainedStreamOf` |
| 6 | `src/Controller.cpp:776` `DeviceObject::rx_thread` | serial `rx`/`tx` | `~DeviceObject` sets stop + `rx_thread.join()` in the dtor BODY before members die | the rx loop reading serial | **SAFE** — join precedes member destruction |
| 7 | `include/Pipe.h:210` `SyntheticProducer::thread_` (test scaffold) | own state | `stop()`/dtor join; `Publisher` has an S-1a `on_close` backstop fired by `PipeHub::drop` before teardown | pipe drop | **SAFE** — join in dtor; test-only |
| 8 | `include/CallbackSlot.h` clock-metrics slot | `std::atomic` armed flag + Dispatcher | env teardown DISARMS before the JS ref dies; `fire()` re-checks armed on the main thread | any owner thread firing metrics | **SAFE** — disarm-before-teardown discipline, main-thread-sequenced |
| 9 | `src/Dispatcher.cpp` `Context` (uv_async) | uv handle + task queue | `~Context` closes async + returns (B-21), holder freed by `close_cb` on the owning loop; last ref dropped OUTSIDE the registry lock | pending `~Future` → `decFuture` → `get(env)` | **SAFE (prior fix)** — B-21 |
| 10 | `include/CoreObject.h` static `locals` Guard | per-class static mutex | on ABNORMAL process exit (no explicit `cleanup()`), env `AddCleanupHook`s run after the static `locals` may already be gone → `mutex lock failed: EINVAL` in the hook, **caught + logged** by `Cleanup::~Registry`, never aborts | static-destruction order | **SUSPECT (benign, documented)** — only on an exit that skips `cleanup()`; caught, non-fatal. Not fixed (out of Stream family) |

Counts: **2 FIXED** (the incident + the lost-wakeup), **1 FIXED transitively**
(all bricks), **4 SAFE**, **1 SAFE-prior**, **2 SUSPECT documented** (#4, #10).

### SUSPECT #4 — ClockCalibrator vs contended fake camera

`core/test/36` (and previously `core/test/27`) intermittently SIGSEGVs in a
`ClockCalibrator` thread — `ClockCalibrator::run → calibrateCameraClock →
Camera::execute_feature → Arv::Error::check`. The `ClockCalibrator`'s OWN
primitives are safe (`~ClockCalibrator` joins before the `Camera` members die,
and `calibrator_` is declared last so it destructs first). The crash is at the
**aravis/glib** layer: the fake camera enumeration path (`Camera.list()` → grab
probe) constructs multiple `Camera` objects, each spawning a calibrator that runs
`calibrateCameraClock` concurrently against per-process glib/aravis state during
teardown. Verdict: **pre-existing library-thread-safety / global-state race, not
one of the app's own mutexes destroyed-under-use** (memory-documented for test
27). Baseline HEAD fails `core/test/36` ~3/6 for this reason — independent of the
Stream fix (mine is ~1/5). **Not fixed** (out of the Stream family, would be a
broad refactor of the calibration/enumeration path). **Mitigated** by the crash
handler (Task 3): these are now printed native stacks instead of silent SIGSEGVs.

## Native crash-site tracing (Task 3)

`core/lib/utils/CrashHandler.cpp`, exported as root `installCrashHandler()`
(idempotent):

- **`std::set_terminate`** hook: prints a banner, the uncaught exception's
  `what()` (recovered by rethrowing `std::current_exception` — the terminate path
  is not a signal context), the module load base, and the native backtrace, then
  `abort()` — so exit-code semantics (6 → janitor) are preserved.
- **SIGABRT/SIGSEGV/SIGBUS** handlers (`sigaction`, `SA_RESETHAND`): async-signal-
  pragmatic — only `write(2)`, `backtrace`/`backtrace_symbols_fd`, and a manual
  hex writer (no malloc/printf/std::string). Print the banner + module base +
  backtrace, then **re-raise**. `SA_RESETHAND` restored `SIG_DFL` before entry, so
  the re-raise takes the default action: the process dies with the same signal,
  exit code unchanged. A re-entrancy guard (`g_dumped`) means `terminate → abort`
  prints once, not twice.

**Why re-raise preserves janitor semantics.** The handler observes-and-dies; it
never swallows. `SA_RESETHAND` + `raise(sig)` = default disposition, so the
faulting thread still dies with its original signal / exit code. An Electron
child's crashpad (if it also hooked these) still sees the death. Exit 6 → the
janitor still parks MEMS + cameras (hardware-quiescence invariant intact).

**Output shape on the incident's abort:**

```
=== FoveaCam native crash handler === std::terminate
  uncaught exception: mutex lock failed: Invalid argument
  module: …/core/dist/.bin/node-26.4.0-arm64.node  base=0x…
  symbolicate offset-only frames with: atos -o <core.node> -l 0x… <addr>
0  node-26.4.0-arm64.node  0x…  _ZN…print_backtraceEv
1  node-26.4.0-arm64.node  0x…  crash_terminate_handler
…
4  node-26.4.0-arm64.node  0x…  _ZN10SubscriberINSt3__110shared_ptrIiEEED2Ev   ← ~Subscriber
=== end native backtrace (aborting; exit code preserved) ===
```

**Boot wiring** (app side, one-line calls, all within `app/orchestrator/`):
`installCrashHandler()` at the earliest core-loading point of every
orchestrator-process entry — `index.ts` (eager static `core` import),
`janitor.ts` (the one-shot IIFE), `probe.ts` (as soon as `core` resolves).

## Verification (as-shipped)

- `cd core && make` — clean (adds `lib/Stream/StreamSelfTest.cpp` +
  `lib/utils/CrashHandler.cpp`).
- `core/test/38-stream-teardown-race.ts` — PRE-FIX (HEAD `Stream.h`) reproduces
  the incident abort (`mutex lock failed` in `~Subscriber`) / the lost-wakeup
  wedge (watchdog SIGKILL); POST-FIX 30 000 teardown iterations clean (~5 s),
  150 000+ across repeats. Hardware-free (native self-test, no camera /
  ClockCalibrator noise).
- `core/test/36-stream-close-deadlock.ts` — churn completes (6023 cycles, no
  deadlock, no destroyed-mutex); residual ~50 % flake is SUSPECT #4 (ClockCalibrator
  enumeration), pre-existing, re-run per the stage-F note.
- Core suite 10–15,17,18,20,22,23,25,26,27,29,34,35,37 — all pass.
- `cd app && npx vue-tsc --noEmit` — 0 errors; `npx vitest run` — 779/779 pass.

## Files changed

- `core/lib/Stream/Stream.h` — eject-all-and-drain, `closes_in_flight_` gate,
  `Subscriber::detach()`, lost-wakeup fix, LIFETIME ORDER comment.
- `core/lib/Stream/StreamSelfTest.cpp` (new) + `core/test/38-stream-teardown-race.ts`
  (new) — hardware-free teardown-race guard.
- `core/lib/utils/CrashHandler.cpp` (new) — native crash tracing.
- `core/Addon.cpp` — export `installCrashHandler` + `__streamTeardownRaceSelfTest`.
- `core/dist/index.mjs` / `core/dist/index.d.ts` — surface `installCrashHandler`.
- `app/orchestrator/{index,janitor,probe}.ts` — one-line boot hooks.
- `docs/hardware/stage-f.md` — "### Teardown hardening" rig checklist.
