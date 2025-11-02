// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <napi.h>

#include <exception>
#include <functional>

#include <type_name.h>
#include <utils/debug.h>
#include <utils/error.h>
#include <utils/stacktrace.h>

#include "napi-helper.h"

#if defined ASYNC_TASK_EXTERNAL
#include "Dispatcher.h"
#include <thread>

template <typename T> class AsyncTask {
  static inline const std::string NAME = "AsyncTask<" + type_name<T>() + ">";
  const Napi::Env env;
  const std::string action;
  Napi::Reference<Napi::Value> container;
  Dispatcher::Future future = {env};
  T result;
  void work(std::function<T()> task) {
    try {
      VERBOSE("%s Started", action.c_str());
      result = task();
      VERBOSE("%s Completed", action.c_str());
      Dispatcher::dispatch(env, [this](napi_env) { this->Resolve(); });
    } catch (const TracedError &e) {
      ERROR("%s Error in task(): %s", action.c_str(), e.what());
      Dispatcher::dispatch(
          env, [this, what = std::string(e.what()), stack = e.stack](napi_env) {
            this->Reject(what, stack);
          });
    } catch (const std::exception &e) {
      ERROR("%s Error in task(): %s", action.c_str(), e.what());
      Dispatcher::dispatch(env, [this, what = std::string(e.what()),
                                 stack = Stacktrace::capture()](napi_env) {
        this->Reject(what, stack);
      });
    } catch (...) {
      ERROR("%s Unknown error in task()", action.c_str());
      VERBOSE("Stack trace:\n%s", Stacktrace::capture().c_str());
      Dispatcher::dispatch(env,
                           [this, stack = Stacktrace::capture()](napi_env) {
                             this->Reject("Unknown error", stack);
                           });
    }
  }
  inline void Resolve() {
    try {
      future.Resolve(container.IsEmpty()
                         ? convert(env, result)
                         : convert(env, container.Value(), result));
    } catch (const TracedError &e) {
      ERROR("%s Failed to resolve: %s", action.c_str(), e.what());
      return Reject(std::string("Error in convert: ") + e.what(), e.stack);
    } catch (const std::exception &e) {
      ERROR("%s Failed to resolve: %s", action.c_str(), e.what());
      VERBOSE("Stack trace:\n%s", Stacktrace::capture().c_str());
      return Reject(e.what(), Stacktrace::capture());
    } catch (...) {
      ERROR("%s Failed to resolve: Unknown Error", action.c_str());
      VERBOSE("Stack trace:\n%s", Stacktrace::capture().c_str());
      return Reject("Unknown error", Stacktrace::capture());
    }
    delete this;
  }
  inline void Reject(std::string what, std::string stack) {
    auto e = Napi::Error::New(this->env, what);
    future.Reject(injectNativeStack(e, stack).Value());
    delete this;
  }
  static inline std::string makeAction(const std::string &name) {
    if (name.empty())
      return NAME;
    else
      return NAME + "::" + name;
  }
  inline AsyncTask(Napi::Env env, std::function<T()> task,
                   const std::string action = "")
      : env(env), action(makeAction(action)), future(env) {
    std::thread(&AsyncTask::work, this, task).detach();
  }
  inline AsyncTask(const Napi::Value &container, std::function<T()> task,
                   const std::string action = "")
      : env(container.Env()), container(Napi::Persistent(container)),
        action(makeAction(action)), future(env) {
    std::thread(&AsyncTask::work, this, task).detach();
  }

public:
  static inline Napi::Promise run(Napi::Env env, std::function<T()> task,
                                  const std::string &action = "") {
    auto asyncTask = new AsyncTask(env, task, action);
    return asyncTask->future.Promise();
  }
  static inline Napi::Promise run(const Napi::Value &container,
                                  std::function<T()> task,
                                  const std::string &action = "") {
    auto asyncTask = (container.IsNull() || container.IsUndefined())
                         ? new AsyncTask(container.Env(), task, action)
                         : new AsyncTask(container, task, action);
    return asyncTask->future.Promise();
  }
};

#else

template <typename R> class AsyncTask : public Napi::AsyncWorker {
  static inline const std::string NAME = "AsyncTask<" + type_name<R>() + ">";
  // To be executed in worker thread, performs the actual task
  using Task = std::function<R()>;
  Napi::Env const env;
  Task const task;
  const std::string action;
  // const Napi::Value container;
  const Napi::Reference<Napi::Value> container;
  const Napi::Promise::Deferred deferred;
  R result;
  std::string stacktrace;
  AsyncTask(Napi::Env env, Task task, std::string action = "")
      : Napi::AsyncWorker(env), env(env), task(task), container(),
        deferred(Napi::Promise::Deferred::New(env)), action(action) {
    if (!action.empty())
      VERBOSE("%s  Requested : %s", NAME.c_str(), action.c_str())
  };
  AsyncTask(const Napi::Value &container, Task task, std::string action = "")
      : Napi::AsyncWorker(container.Env()), env(container.Env()), task(task),
        container(Napi::Persistent(container)),
        deferred(Napi::Promise::Deferred::New(env)), action(action) {
    if (!action.empty())
      VERBOSE("%s  Requested: %s", NAME.c_str(), action.c_str())
  }
  void Execute() override {
    try {
      if (!action.empty())
        VERBOSE("%s Dispatched: %s", NAME.c_str(), action.c_str());
      result = task();
      if (!action.empty())
        VERBOSE("%s  Completed: %s", NAME.c_str(), action.c_str());
    } catch (const std::exception &e) {
      stacktrace = Stacktrace::capture();
      SetError(e.what());
    } catch (...) {
      stacktrace = Stacktrace::capture();
      SetError("Unknown error");
    }
  }

  void OnOK() override {
    try {
      Napi::HandleScope scope(env);
      auto container =
          this->container.IsEmpty() ? env.Undefined() : this->container.Value();
      deferred.Resolve(convert(env, container, result));
      if (!action.empty())
        VERBOSE("%s Resolved  : %s", NAME.c_str(), action.c_str());
      return;
    } catch (JS::ErrorBase &e) {
      deferred.Reject(e.error().Value());
    } catch (const std::exception &e) {
      deferred.Reject(JS::Error(env, e.what()).error().Value());
    } catch (...) {
      deferred.Reject(
          JS::Error(env, "Unknown error occurred in OnOK()").error().Value());
    }
    WARN("%s Resolve %s Failed", NAME.c_str(), action.c_str());
  }

  void OnError(const Napi::Error &e) override {
    try {
      Napi::HandleScope scope(env);
      deferred.Reject(injectNativeStack(e, stacktrace).Value());
      if (!action.empty())
        VERBOSE("%s   Rejected: %s", NAME.c_str(), action.c_str());
      return;
    } catch (const std::exception &e) {
      ERROR("%s Exception occurred in OnError(): %s", NAME.c_str(), e.what());
    } catch (...) {
      ERROR("%s Unknown exception occurred in OnError()", NAME.c_str());
    }
    WARN("%s Reject %s Failed", NAME.c_str(), action.c_str());
  }

public:
  static inline Napi::Promise run(Napi::Env env, Task task,
                                  std::string action = "") {
    auto worker = new AsyncTask(env, task, action);
    auto promise = worker->deferred.Promise();
    worker->Queue();
    return promise;
  }
  static inline Napi::Promise run(const Napi::Value &container, Task task,
                                  std::string action = "") {
    if (container.IsUndefined() || container.IsNull())
      return run(container.Env(), task, action);
    auto worker = new AsyncTask(container, task, action);
    auto promise = worker->deferred.Promise();
    worker->Queue();
    return promise;
  }
};

#endif
