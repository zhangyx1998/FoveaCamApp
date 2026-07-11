# core Stream / Subscriber lifetime

Behavior spec for `core/lib/Stream/Stream.h` (`Stream<T>` publisher +
`Subscriber<T>`). These are the teardown-safety rules that prevent a family of
reintroduction bugs — the code carries `// spec:` pointers back to the anchors
below. Nothing here is aspirational; every rule closed a specific crash/hang.

`Stream<T>` runs one producer thread that fans a payload out to N subscribers
under `mutex`. `Shared<Stream>` is intentionally unsupported (add it in a derived
class if ever needed). A subscriber can be ejected from BOTH ends: the stream
pops all subscribers on crash/terminate; a subscriber pops only itself when
destructed from the subscribing end.

## lost-wakeup {#lost-wakeup}

`shutdown()` sets `flag_terminate` UNDER `mutex`, then `notify_all`.
`wait_activate()` evaluates its predicate (which reads `flag_terminate`) while
holding `mutex` and then atomically unlocks+sleeps in `unfreeze.wait()`. If the
flag were flipped + notified WITHOUT the mutex (the historical code), the notify
could land in the gap after the parking thread read the flag as false but before
it blocked — a lost wakeup: the producer sleeps forever and the `thread.join()`
hangs, the orchestrator never exits, and hardware stays armed. A hung teardown
violates the quiescence invariant as badly as an aborted one. Flipping the flag
under `mutex` serializes against the predicate check, so the `notify_all` is
never lost.

## eject-and-drain {#eject-and-drain}

The destroyed-mutex race fix (2026-07-09 exit-6 abort). After `shutdown()` joins
the producer thread, THIS stream's own thread can never touch `mutex` /
`subscribers` again. What remains is a cross-thread `Subscriber::close()` racing
our destruction: on a CLEAN shutdown (unlike `crash()`) the base historically
left every subscriber's back-pointer intact — so a subscriber destroyed AFTER us
would `close() -> unsubscribe()` and lock a freed `mutex`. `eject_all_and_drain()`
closes this in two moves, both BEFORE `~Stream` frees `mutex`:

1. **eject** — null every still-attached subscriber's back-pointer (via
   `detach()`, under the stream `mutex` and each subscriber's state guard) so any
   LATER `close()` sees a dead stream and skips `unsubscribe()`.
2. **drain** — spin-wait (`yield`) until `closes_in_flight_` reaches 0, i.e. any
   `close()` already past its null-check and in flight toward `unsubscribe()` has
   finished touching `mutex`.

Idempotent (a re-entry finds an empty set and a zero counter); teardown path
only, never hot. Lock order matches the publisher fan-out (stream `mutex` FIRST,
then each subscriber's state guard via `detach()`) — never the reverse — so it
cannot deadlock against `Subscriber::close`, which takes ONLY the state guard,
then an atomic, then releases before reaching for `mutex`.

`closes_in_flight_` counts `Subscriber::close(unsubscribe=true)` calls that have
captured a LIVE pointer to this stream (under the subscriber's state guard) and
are in flight toward `unsubscribe()`. The increment lands while the pointer is
provably live (see [lifetime-order](#lifetime-order)); the decrement follows
`unsubscribe()`. It is never contended on the hot path.

## lock-order {#lock-order}

`Subscriber::close()` must NOT hold the state guard across the call into
`Stream::unsubscribe` (which takes the stream `mutex`). The publisher fan-out in
`Stream::loop()` holds the stream `mutex` first, then takes each subscriber's
state guard — so holding the state guard while reaching for the stream mutex is
the opposite order and deadlocks. (Observed: a TransformStream thread exiting →
`~Latest` → `~Subscriber` → `close(true)` racing its upstream fan-out wedged the
whole app; the fan-out stuck wanting a state guard, this `unsubscribe` stuck
wanting the stream mutex.) Therefore: freeze the state under the guard (capture +
null the stream pointer, set the error), RELEASE the guard, and only then
`unsubscribe`. This reorder (commit ee6fc46) is safe:

1. `push()` is still never called on a closed subscriber: the fan-out checks
   `ref->isActive()` under the state guard, and once the stream is nulled (under
   that same guard) a concurrent fan-out skips this sub.
2. No use-after-free: `unsubscribe()` blocks on the stream mutex, which the
   fan-out holds for its entire iteration; so this subscriber cannot be erased
   (and `~Subscriber` cannot complete) while the loop might still dereference it.
3. Double-close stays idempotent: a second call sees `stream == nullptr` and
   returns early.
4. Derived overrides (`Sub::Queue` / `Sub::Latest` / `TapPublisher` /
   `RecordSink`) call this base FIRST, then drain on a *different* guard — they
   only rely on the state being frozen (stream nulled + error set) before return.

Calls originating from Stream itself pass `unsubscribe = false` (they already
hold the stream mutex / are erasing us directly), so they never reach the
unsubscribe path regardless.

## lifetime-order {#lifetime-order}

The destroyed-mutex race, subscriber side (2026-07-09 exit-6 abort). The
[lock-order](#lock-order) reorder releases the state guard before locking
`stream->mutex`, so nothing intrinsically keeps `stream` ALIVE across the
`unsubscribe()` call — a concurrent `~Stream` (owning brick teardown) could free
`stream->mutex` in that gap, and `unsubscribe()` would then lock a destroyed
mutex (macOS libc++ `std::mutex` reports EINVAL → `std::system_error` thrown from
a `noexcept ~Subscriber` → `std::terminate`). Closed by pairing with
[eject-and-drain](#eject-and-drain):

- Before `~Stream` frees `mutex`, `shutdown()` nulls EVERY subscriber's
  back-pointer under that subscriber's OWN state guard. So the only way to
  observe `ref->stream != nullptr` while holding the state guard is that the
  eject has NOT yet processed us — which (because it needs this same guard) means
  it is blocked behind us and cannot have advanced to free the stream. Therefore
  `stream` is provably ALIVE at the `closes_in_flight_` increment.
- We bump `closes_in_flight_` WHILE STILL HOLDING the state guard (a plain
  atomic — no lock, so the ee6fc46 lock order is untouched). The
  [eject-and-drain](#eject-and-drain) drain refuses to return (and thus `~Stream`
  refuses to free `mutex`) until this count is 0, i.e. until our `unsubscribe()`
  and its matching decrement have completed. A `close()` that arrives AFTER the
  eject sees `stream == nullptr` at the guard and never increments.

## assert-shutdown {#assert-shutdown}

`~Stream` aborts if the producer thread is still joinable: the thread may call
into derived-class virtuals, so derived destructors MUST call `shutdown()` before
their own members are destroyed. Checked at the base to avoid hard-to-debug UAF.
