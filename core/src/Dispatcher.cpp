// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <deque>
#include <mutex>
#include <stdexcept>

#include "Dispatcher.h"

#include "utils/map-set.h"
#include "utils/napi-helper.h"
#include "uv.h"

namespace Dispatcher {

class Dispatcher {
public:
  typedef std::shared_ptr<Dispatcher> Ptr;
  static inline Ptr create(Napi::Env env) {
    return std::make_shared<Dispatcher>(env);
  }
  static void onAsync(uv_async_t *handle);
  Dispatcher(Napi::Env env);
  ~Dispatcher();
  Task getNextTask();
  void updateRef();
  inline void notify() { uv_async_send(&async); }
  inline bool isClosing() {
    return uv_is_closing(reinterpret_cast<uv_handle_t *>(&async));
  }

  Napi::Env env;
  bool active = true;
  bool referenced = true; // uv handle is referenced by default
  uv_loop_t *loop = nullptr;
  uv_async_t async;
  std::mutex mutex;
  std::deque<Task> queue;
};

static std::mutex registry_mutex;
static Map<napi_env, Dispatcher::Ptr> registry;

void Dispatcher::onAsync(uv_async_t *handle) {
  const auto self = static_cast<Dispatcher *>(handle->data);
  auto &env = self->env;
  // Main thread: run queued tasks with proper N-API scopes
  Napi::HandleScope hs(env);
  for (;;) {
    Task t = self->getNextTask();
    if (t)
      t(env);
    else
      break;
  }
  self->updateRef();
}

Dispatcher::Dispatcher(Napi::Env env) : env(env) {
  napi_status s = napi_get_uv_event_loop(env, &loop);
  if (s != napi_ok)
    throw std::runtime_error("get_uv_event_loop failed");
  async.data = this;
  if (uv_async_init(loop, &async, onAsync) != 0)
    throw std::runtime_error("uv_async_init failed");
  updateRef();
}

Dispatcher::~Dispatcher() {
  {
    std::lock_guard<std::mutex> lock(mutex);
    active = false;
    queue.clear();
  }
  updateRef();
}

Task Dispatcher::getNextTask() {
  Task out = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex);
    if (active && !queue.empty()) {
      out = std::move(queue.front());
      queue.pop_front();
    }
  }
  return out;
}

void Dispatcher::updateRef() {
  auto handle = reinterpret_cast<uv_handle_t *>(&async);
  if (isClosing())
    return;
  std::scoped_lock lock(mutex);
  if (!referenced && !queue.empty()) {
    uv_ref(handle);
    referenced = true;
  } else if (referenced && (queue.empty() || !active)) {
    uv_unref(handle);
    referenced = false;
  }
}

Dispatcher::Ptr get(Napi::Env env) {
  std::scoped_lock lock(registry_mutex);
  if (!registry.has(env))
    throw JS::Error(env, "Dispatcher not initialized for this env");
  return registry.get(env);
}

void dispatch(Napi::Env env, Task task) {
  auto dispatcher = get(env);
  {
    std::lock_guard<std::mutex> lock(dispatcher->mutex);
    if (!dispatcher->active)
      return;
    dispatcher->queue.push_back(std::move(task));
  }
  dispatcher->updateRef();
  dispatcher->notify();
}

void cleanup(napi_env env) {
  std::scoped_lock lock(registry_mutex);
  if (registry.has(env))
    registry.erase(env);
}

void init(Napi::Env &env) {
  std::scoped_lock lock(registry_mutex);
  if (registry.has(env))
    throw JS::Error(env, "Dispatcher already initialized for this env");
  registry.set(env, Dispatcher::create(env));
  env.AddCleanupHook(cleanup, static_cast<napi_env>(env));
}

} // namespace Dispatcher
