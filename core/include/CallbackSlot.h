// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// GENERALIZED metric-channel primitive (unified-time revision, 2026-07-08):
// an OPTIONAL JS callback into the orchestrator main thread. One static slot
// per channel — the clock-metrics channel wires through it now; other metric
// channels (converter/tracker meters, topology deltas) are meant to adopt the
// SAME pattern instead of inventing new TSFN plumbing. Pull surfaces
// (probeAll/clockStabilityAll) are unaffected — this is the push path.
//
// Contract:
//   - `set()`/`clear()` run on the ORCHESTRATOR MAIN (NAPI) thread ONLY —
//     they are inherently NAPI-setter entry points; the FunctionReference is
//     created/reset exclusively there.
//   - `armed()` is ONE lock-free atomic load — the producer (owner) thread
//     checks it FIRST and ENTIRELY OMITS the uv dispatch when no callback is
//     registered: an unobserved channel costs nothing cross-thread.
//   - `fire(build)` may be called from ANY thread: when armed it queues onto
//     the existing Dispatcher (uv_async → main thread), where `build(env)`
//     materializes the JS argument and the callback is invoked. The armed
//     flag is re-checked ON the main thread, so a clear() that lands while a
//     dispatch is in flight suppresses delivery (set/clear/deliver are all
//     main-thread-sequenced — no torn callback refs).
//   - Env teardown disarms the slot BEFORE the reference dies: the first
//     `set()` registers a `Cleanup` hook (same discipline as the
//     reader/writer context-safety work).

#include <atomic>
#include <functional>
#include <string>
#include <utility>

#include <napi.h>

#include "Cleanup.h"
#include "Dispatcher.h"
#include "utils/debug.h"

class CallbackSlot {
public:
  explicit CallbackSlot(std::string name) : name_(std::move(name)) {}
  CallbackSlot(const CallbackSlot &) = delete;
  CallbackSlot &operator=(const CallbackSlot &) = delete;

  /** MAIN THREAD ONLY (the NAPI setter). A Function arms the slot; any other
   *  value (null/undefined) disarms it. */
  void set(Napi::Env env, Napi::Value cb) {
    if (!cb.IsFunction()) {
      clear();
      return;
    }
    ref_ = Napi::Persistent(cb.As<Napi::Function>());
    env_ = env;
    if (cleanup_ == 0)
      cleanup_ = Cleanup::add(
          env, [this] { disarm(); }, "CallbackSlot:" + name_);
    armed_.store(true, std::memory_order_release);
  }

  /** MAIN THREAD ONLY. Disarm + drop the callback reference. */
  void clear() {
    armed_.store(false, std::memory_order_release);
    ref_.Reset();
  }

  /** Lock-free armed indicator — safe from any thread. */
  bool armed() const { return armed_.load(std::memory_order_acquire); }

  /** Builds the JS argument ON the main thread at delivery time (the
   *  producer captures its metrics ROW by value into this functor). */
  using Build = std::function<Napi::Value(Napi::Env)>;

  /** ANY THREAD. No-op (one atomic load) when disarmed; otherwise queue the
   *  delivery through the Dispatcher. Never throws into the producer. */
  void fire(Build build) {
    if (!armed()) // the zero-cost gate — no uv traffic unobserved
      return;
    try {
      Dispatcher::dispatch(
          env_, [this, build = std::move(build)](Napi::Env env) {
            // Re-check ON the main thread: a clear()/teardown that raced the
            // queue wins (set/clear/deliver are main-thread-sequenced).
            if (!armed_.load(std::memory_order_acquire) || ref_.IsEmpty())
              return;
            try {
              ref_.Call({build(env)});
            } catch (const std::exception &e) {
              WARN("CallbackSlot(%s): callback threw: %s", name_.c_str(),
                   e.what());
            }
          });
    } catch (const std::exception &e) {
      // Dispatcher gone (env teardown race) — drop the event, never crash
      // the producer thread.
      WARN("CallbackSlot(%s): dispatch failed: %s", name_.c_str(), e.what());
    }
  }

private:
  void disarm() { // Cleanup hook (env teardown, main thread)
    armed_.store(false, std::memory_order_release);
    ref_.Reset();
    cleanup_ = 0;
  }

  const std::string name_;
  std::atomic<bool> armed_{false};
  Napi::FunctionReference ref_; // main-thread create/reset/call only
  Napi::Env env_ = nullptr;     // valid while armed (set before the release
                                // store; producers read it only after the
                                // acquire load of `armed_`)
  Cleanup::UID cleanup_ = 0;
};
