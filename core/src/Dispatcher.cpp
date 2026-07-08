// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <deque>

#include <uv.h>

#include "Cleanup.h"
#include "Dispatcher.h"
#include "Threading/Guard.h"
#include "napi-helper.h"
#include "utils/debug.h"
#include "utils/error.h"
#include <pointer.h>

#include <utils/map-set.h>

namespace Dispatcher {

using Threading::Guard;

static void async_cb(uv_async_t *handle);

// The uv_async_t lives in a heap holder that OUTLIVES its Context. `~Context`
// must not block waiting for the async close callback: when `~Context` is
// reached from inside the uv loop (e.g. `cleanup()` invoked from a module
// top-level await, resuming inside `uv_run`), a nested `uv_run` never advances
// to the "closing handles" phase → the callback never fires → hang (B-21).
// Instead `~Context` calls `uv_close(&h->async, close_cb)` and RETURNS; the
// owning loop drains the close and `close_cb` frees the holder.
struct AsyncHandle {
  uv_async_t async;
};

struct Context {
  napi_env env;
  AsyncHandle *h; // freed by close_cb after uv_close (outlives this Context)
  Napi::AsyncContext async_context;
  uv_handle_t *handle() { return reinterpret_cast<uv_handle_t *>(&h->async); }

  unsigned future = 0;

  static Context *from_handle(uv_handle_t *handle) {
    return static_cast<Context *>(handle->data);
  }

  inline void incFuture() {
    future++;
    updateRef();
  }

  inline void decFuture() {
    if (future > 0)
      future--;
    else
      throw TracedError("Dispatcher::future decremented below zero");
    updateRef();
  }

  std::deque<Task> queue;

  void dispatch(Task &&task) {
    queue.push_back(std::move(task));
    updateRef();
    uv_async_send(&h->async);
  }

  Task getNextTask() {
    if (queue.empty())
      return nullptr;
    auto task = std::move(queue.front());
    queue.pop_front();
    return task;
  }

  size_t queueSize() const { return queue.size(); }

  bool referenced = true; // uv handle is referenced by default

  void updateRef() {
    if (uv_is_closing(handle())) {
      WARN("Dispatcher UV handle is closing, cannot updateRef()");
      return;
    }
    bool shouldReference = future > 0 || !queue.empty();
    if (!referenced && shouldReference) {
      uv_ref(handle());
      referenced = true;
    } else if (referenced && !shouldReference) {
      uv_unref(handle());
      referenced = false;
    }
  }

  Context(napi_env env)
      : env(env), h(new AsyncHandle{}), async_context(env, "Dispatcher") {
    h->async.data = this;
    VERBOSE("Dispatcher created @ %p (async handle)", &h->async);
    uv_loop_t *loop;
    napi_status s = napi_get_uv_event_loop(env, &loop);
    if (s != napi_ok) {
      delete h;
      throw JS::Error(env, "napi_get_uv_event_loop failed");
    }
    if (uv_async_init(loop, &h->async, async_cb) != 0) {
      delete h;
      throw JS::Error(env, "uv_async_init failed");
    }
    updateRef();
  }

  // Runs on the OWNING uv loop after this Context is already gone; frees the
  // holder that outlived it. Recovers the holder from the handle pointer
  // (uv_async_t is AsyncHandle's only member) — never touches the dead Context.
  static void close_cb(uv_handle_t *handle) {
    VERBOSE("Dispatcher UV handle closed @ %p", handle);
    delete reinterpret_cast<AsyncHandle *>(handle);
  }

  ~Context() {
    if (referenced) {
      WARN("Dispatcher destroyed with active references");
      uv_unref(handle());
    }
    // Close asynchronously and RETURN — do NOT block on the close callback. The
    // holder `h` is handed to close_cb (which frees it on the owning loop); the
    // old `while (!closed) uv_run(NOWAIT)` deadlocked when reached from inside
    // the loop (B-21). `h` is a raw pointer, so ~Context does not free it.
    if (!uv_is_closing(handle())) {
      VERBOSE("Closing dispatcher UV handle");
      uv_close(handle(), close_cb);
    }
  }
};

class Dispatcher : public Shared<Dispatcher> {
  friend void async_cb(uv_async_t *handle);

public:
  Napi::Env env;
  Guard<Context> ctx;
  inline Guard<Context>::Ref ref() { return ctx.ref(); }
  Dispatcher(Napi::Env env) : env(env), ctx(env) {};
};

typedef Guard<Map<napi_env, Dispatcher::Ptr>> Registry;
static Registry registry;

Dispatcher::Ptr get(Napi::Env env) {
  auto ref = registry.ref();
  if (ref->has(env))
    return ref->get(env);
  else
    return nullptr;
}

static void async_cb(uv_async_t *handle) {
  auto *ctx = Context::from_handle(reinterpret_cast<uv_handle_t *>(handle));
  const auto &env = ctx->env;
  auto dispatcher = get(env);
  if (!dispatcher) {
    WARN("Dispatcher async_cb called after cleanup");
    return;
  }
  Napi::HandleScope hs(env);
  auto ref = dispatcher->ref();
  Napi::CallbackScope cs(env, ref->async_context);
  ref.release();
  size_t processed = 0;
  while (true) {
    auto task = dispatcher->ref()->getNextTask();
    if (!task)
      break;
    try {
      task(env);
      processed++;
    } catch (const std::exception &e) {
      ERROR("Unhandled exception in Dispatcher task: %s", e.what());
    } catch (...) {
      ERROR("Unknown exception in Dispatcher task");
    }
  }
  // Update ref count once after processing all tasks
  if (processed > 0) {
    auto ref = dispatcher->ref();
    auto remaining = ref->queueSize();
    VERBOSE("drain n=%zu remaining=%zu", processed, remaining);
    ref->updateRef();
  }
}

void init(Napi::Env env) {
  auto ref = registry.ref();
  if (ref->has(env))
    throw JS::Error(env, "Dispatcher already initialized for this env");
  auto dispatcher = Dispatcher::create(env);
  ref->set(env, dispatcher);
  Cleanup::add(
      env,
      [env] {
        // Extract + erase under the registry lock, then DROP the Dispatcher's
        // last reference OUTSIDE the lock. Destroying it runs ~Context, which
        // (now that it no longer hangs on the uv close — B-21) proceeds to
        // destroy its pending-task queue → ~Future → decFuture → get(env),
        // which re-acquires this same registry lock. Dropping under the lock
        // would deadlock (a pending future at cleanup() reproduces it).
        Dispatcher::Ptr dying;
        {
          auto ref = registry.ref();
          if (ref->has(env)) {
            dying = ref->get(env);
            ref->erase(env);
          }
        }
      },
      "Dispatcher");
}

void dispatch(Napi::Env env, Task &&task) {
  auto dispatcher = get(env);
  if (!dispatcher)
    throw JS::Error(env, "Dispatcher not initialized for this env");
  dispatcher->ref()->dispatch(std::move(task));
}

Future::Future(Napi::Env env) : Deferred(env) {
  auto dispatcher = get(Env());
  if (!dispatcher)
    throw JS::Error(Env(), "Dispatcher not initialized for this env");
  dispatcher->ref()->incFuture();
}

Future::Future(Deferred &&other) : Deferred(other) {
  auto dispatcher = get(Env());
  if (!dispatcher)
    throw JS::Error(Env(), "Dispatcher not initialized for this env");
  dispatcher->ref()->incFuture();
}

Future::~Future() {
  auto dispatcher = get(Env());
  if (dispatcher) {
    dispatcher->ref()->decFuture();
  } else {
    // Dispatcher already cleaned up, this is fine during shutdown
    WARN("Future destroyed after Dispatcher cleanup");
  }
}

} // namespace Dispatcher
