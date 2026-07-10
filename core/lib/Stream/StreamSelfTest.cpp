// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Hardware-free native self-test for the destroyed-mutex teardown race
// (core/test/38-stream-teardown-race.ts). Deliberately isolated from cameras /
// the ClockCalibrator so the ONLY thing under stress is Stream destruction vs
// concurrent Subscriber::close(unsubscribe=true).
//
// The race (2026-07-09 exit-6 incident): Subscriber::close() captures a raw
// Stream* under its state guard, releases the guard, then locks stream->mutex in
// unsubscribe(). If the owning object's ~Stream frees that mutex in the gap, the
// lock hits a destroyed std::mutex — macOS libc++ reports EINVAL -> system_error
// -> thrown from the noexcept ~Subscriber -> std::terminate (exit 6). Pre-fix
// this self-test aborts/segfaults within a few iterations; post-fix (eject-all-
// and-drain in Stream::shutdown + the closes_in_flight_ gate) it runs clean.

#include <atomic>
#include <memory>
#include <thread>
#include <vector>

#include <napi.h>

#include <Stream/Stream.h>

namespace {

using Payload = std::shared_ptr<int>;

// Minimal concrete Stream. iterate() PARKS (returns nullptr) rather than
// producing: the base loop then just spins lock(mutex)/unlock while subscribed,
// which is exactly the window a cross-thread unsubscribe()/close() must race
// against ~Stream — WITHOUT fanning out to (and dereferencing) subscriber
// pointers. That keeps this test squarely on the INCIDENT (Subscriber::close vs
// stream destruction / the destroyed mutex), not on producer-fan-out lifetime
// (a subscriber deleted with no prior close while being actively pushed to is
// not a path any real subscriber takes — they all close() before they die).
struct RaceStream : ::Stream<Payload> {
  ~RaceStream() { shutdown(); }
  void start() override {}
  void stop() override {}
  Payload iterate() override {
    std::this_thread::yield();
    return nullptr;
  }
};

struct RaceSub : Subscriber<Payload> {
  using Subscriber<Payload>::Subscriber;
  // Close in the DERIVED destructor body (vtable still valid), exactly as the
  // real subscribers do (TapPublisher / PipeOfferSubscriber). The close() here
  // is the cross-thread unsubscribe that races ~Stream — the thing under test.
  ~RaceSub() { close(); }
  void push(const Payload &) override {}
};

} // namespace

// __streamTeardownRaceSelfTest(iterations?, closers?) — churns, per iteration:
//   * build a Stream + `closers` subscribers (which start the producer thread),
//   * release ONE destroyer thread (delete stream -> ~Stream) and `closers`
//     closer threads (delete subscriber -> close(unsubscribe=true)) at the SAME
//     instant, so ~Stream and the cross-thread closes genuinely overlap.
// Returns the iteration count. A crash/abort mid-run IS the pre-fix proof; a
// clean return over thousands of iterations is the post-fix soak.
Napi::Value streamTeardownRaceSelfTest(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  const uint32_t iterations = info.Length() > 0 && info[0].IsNumber()
                                  ? info[0].As<Napi::Number>().Uint32Value()
                                  : 4000;
  const uint32_t closers = info.Length() > 1 && info[1].IsNumber()
                               ? info[1].As<Napi::Number>().Uint32Value()
                               : 6;
  for (uint32_t i = 0; i < iterations; i++) {
    auto *s = new RaceStream();
    std::vector<RaceSub *> subs;
    subs.reserve(closers);
    for (uint32_t c = 0; c < closers; c++)
      subs.push_back(new RaceSub(s)); // subscribe -> starts the producer thread
    // Let the producer fan out for a beat so the stream mutex is hot.
    for (int w = 0; w < 64; w++)
      std::this_thread::yield();
    // Release all racers simultaneously.
    std::atomic<bool> go{false};
    std::vector<std::thread> racers;
    racers.reserve(closers + 1);
    racers.emplace_back([&] {
      while (!go.load(std::memory_order_acquire))
        std::this_thread::yield();
      delete s; // ~Stream: pre-fix leaves subs dangling; post-fix ejects+drains
    });
    for (uint32_t c = 0; c < closers; c++)
      racers.emplace_back([&, c] {
        while (!go.load(std::memory_order_acquire))
          std::this_thread::yield();
        delete subs[c]; // ~Subscriber -> close(unsubscribe=true) -> unsubscribe
      });
    go.store(true, std::memory_order_release);
    for (auto &t : racers)
      t.join();
  }
  return Napi::Number::New(env, iterations);
}
