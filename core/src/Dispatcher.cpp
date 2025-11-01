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

#include <iostream>
#include <utils/map-set.h>

namespace Dispatcher {

using Threading::Guard;

static void async_cb(uv_async_t *handle);

struct Context {
  uv_async_t async;
  uv_handle_t *handle() { return reinterpret_cast<uv_handle_t *>(&async); }

  bool closed = false;
  unsigned future = 0;

  // Get Context pointer from uv_handle_t pointer
  // This is safe because uv_async_t is the first member of Context
  static Context *from_handle(uv_handle_t *handle) {
    static_assert(offsetof(Context, async) == 0,
                  "async must be the first member of Context");
    auto *async = reinterpret_cast<uv_async_t *>(handle);
    return reinterpret_cast<Context *>(async);
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
    uv_async_send(&async);
  }

  Task getNextTask() {
    if (queue.empty())
      return nullptr;
    auto task = std::move(queue.front());
    queue.pop_front();
    return task;
  }

  bool referenced = true; // uv handle is referenced by default

  void updateRef() {
    if (uv_is_closing(handle())) {
      std::cerr << "[WARN] Dispatcher UV handle is closing, cannot updateRef()"
                << std::endl;
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

  Context(napi_env env) : async({.data = env}) {
    VERBOSE("Dispatcher created @ %p (async handle)", &async);
    uv_loop_t *loop;
    napi_status s = napi_get_uv_event_loop(env, &loop);
    if (s != napi_ok)
      throw JS::Error(env, "napi_get_uv_event_loop failed");
    if (uv_async_init(loop, &async, async_cb) != 0)
      throw JS::Error(env, "uv_async_init failed");
    updateRef();
  }

  static void close_cb(uv_handle_t *handle) {
    VERBOSE("Dispatcher UV handle closed @ %p", handle);
    Context *ctx = from_handle(handle);
    ctx->closed = true;
  }

  ~Context() {
    if (referenced) {
      std::cerr << "[WARN] Dispatcher destroyed with active references"
                << std::endl;
      uv_unref(handle());
    }
    if (!uv_is_closing(handle())) {
      VERBOSE("Closing dispatcher UV handle");
      uv_close(handle(), close_cb);
    }
    // Wait for the handle to finish closing
    // This is necessary because uv_close is asynchronous and the handle
    // must not be freed until the close callback has been invoked
    VERBOSE("Waiting for dispatcher UV handle to close...");
    while (!closed) {
      // Run the event loop to allow the close callback to execute
      uv_run(async.loop, UV_RUN_NOWAIT);
    }
    VERBOSE("Dispatcher UV handle closed");
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
  const auto &env = static_cast<napi_env>(handle->data);
  auto dispatcher = get(env);
  if (!dispatcher) {
    std::cerr << "[ERROR] Dispatcher async_cb called after cleanup"
              << std::endl;
    return;
  }
  Napi::HandleScope hs(env);
  while (true) {
    auto task = dispatcher->ref()->getNextTask();
    if (!task)
      break;
    try {
      task(env);
    } catch (const std::exception &e) {
      std::cerr << "[ERROR] Unhandled exception in Dispatcher task: "
                << e.what() << std::endl;
    } catch (...) {
      std::cerr << "[ERROR] Unknown exception in Dispatcher task" << std::endl;
    }
    dispatcher->ref()->updateRef();
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
        auto ref = registry.ref();
        if (ref->has(env))
          ref->erase(env);
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
    std::cerr << "[WARN] Future destroyed after Dispatcher cleanup"
              << std::endl;
  }
}

} // namespace Dispatcher
