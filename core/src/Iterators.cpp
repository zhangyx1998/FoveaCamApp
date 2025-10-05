// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstddef>
#include <memory>
#include <napi.h>

#include <utils/debug.h>

#include "Iterators.h"

#include "CoreObject.h"
#include "Dispatcher.h"
#include "napi-helper.h"

using namespace Napi;

// Handles incoming data from stream.
void FrameQueue::push(const Arv::Frame::Ptr &value) {
  VERBOSE("FrameQueue::push(%s)", value ? value->tag().c_str() : "null");
  auto ref = data.ref();
  if (ref->future_queue.empty())
    ref->data_queue.push(value);
  else {
    auto &future = ref->future_queue.front();
    auto task = [future = std::move(future), value = value](Napi::Env env) {
      future->Resolve(IterNext(env, CreateObject(env, std::move(value))));
    };
    ref->future_queue.pop();
    ref.release();
    dispatch(env, task);
  }
}

void FrameQueue::close(bool unsubscribe, TracedError::Ptr err) {
  VERBOSE("FrameQueue::close()");
  Subscriber::close(unsubscribe, err);
  auto ref = data.ref();
  if (err) {
    while (!ref->future_queue.empty()) {
      auto &future = ref->future_queue.front();
      auto task = [future = std::move(future), err](Napi::Env env) {
        auto error = Napi::Error::New(env, err->what());
        injectNativeStack(error, err->stack);
        future->Reject(error.Value());
      };
      ref->future_queue.pop();
      ref.release();
      dispatch(env, task);
    }
  } else {
    while (!ref->future_queue.empty()) {
      auto &future = ref->future_queue.front();
      auto task = [future = std::move(future)](Napi::Env env) {
        future->Resolve(IterNext(env));
      };
      ref->future_queue.pop();
      ref.release();
      dispatch(env, task);
    }
  }
}

FN(FrameQueue::next) {
  auto env = info.Env();
  auto deferred = Napi::Promise::Deferred::New(env);
  auto promise = deferred.Promise();
  auto ref = data.ref();
  if (!ref->data_queue.empty()) {
    auto value = std::move(ref->data_queue.front());
    ref->data_queue.pop();
    ref.release();
    VERBOSE("FrameQueue::next(%s)", value ? value->tag().c_str() : "null");
    deferred.Resolve(IterNext(env, CreateObject(env, std::move(value))));
  } else {
    ref->future_queue.push(Future::create(std::move(deferred)));
    ref.release();
    VERBOSE("FrameQueue::next() pending");
  }
  return promise;
}

FN(FrameQueue::close) {
  VERBOSE("FrameQueue::close([From JS])");
  Subscriber::close();
  auto env = info.Env();
  auto deferred = Napi::Promise::Deferred::New(env);
  deferred.Resolve(IterNext(env));
  return deferred.Promise();
}

class FrameQueueIter : public CoreObject<FrameQueueIter, FrameQueue::Ptr> {
  CORE_OBJECT_DECL(FrameQueueIter);

public:
  using CoreObject<FrameQueueIter, FrameQueue::Ptr>::CoreObject;
  static inline const std::string name = "FrameQueue";
  static inline Function Init(Napi::Env env) {
    auto asyncIterator = Napi::Symbol::WellKnown(env, "asyncIterator");
    return DefineClass(
        env, FrameQueueIter::name.c_str(),
        {
            CORE_OBJECT_REGISTER(FrameQueueIter, env),            //
            InstanceMethod<&FrameQueueIter::self>(asyncIterator), //
            InstanceMethod<&FrameQueueIter::next>("next"),        //
            InstanceMethod<&FrameQueueIter::close>("return"),     //
            InstanceMethod<&FrameQueueIter::close>("throw"),
        });
  }

private:
  FN(self) { return info.This(); }
  FN(next) { return core()->next(info); }
  FN(close) { return core()->close(info); }
};

CORE_OBJECT(FrameQueue::Ptr, FrameQueueIter);

void FrameLatest::push(const Arv::Frame::Ptr &value) { *data.ref() = value; }

FN(FrameLatest::next) {
  auto env = info.Env();
  {
    auto ref = data.ref();
    auto latest = *ref;
    if (latest) {
      *ref = nullptr; // Clear after reading
      return IterNext(env, CreateObject(env, latest));
    }
  }
  // No new frame, check if still active
  const auto s = state.snapshot();
  if (s.isActive()) {
    return IterNext(env, env.Null());
  } else if (s.error) {
    auto &message = s.error->message;
    auto &stack = s.error->stack;
    auto error = Napi::Error::New(env, message);
    injectNativeStack(error, stack);
    error.ThrowAsJavaScriptException();
    return env.Undefined();
  } else {
    return IterNext(env); // Iteration complete
  }
}

FN(FrameLatest::close) {
  VERBOSE("FrameLatest::close()");
  Subscriber::close();
  auto env = info.Env();
  return IterNext(env);
}

Napi::Value FrameLatest::get_current(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  auto ref = data.ref();
  auto &latest = *ref;
  return latest ? CreateObject(env, latest) : env.Null();
}

class FrameLatestIter : public CoreObject<FrameLatestIter, FrameLatest::Ptr> {
  CORE_OBJECT_DECL(FrameLatestIter);

public:
  using CoreObject<FrameLatestIter, FrameLatest::Ptr>::CoreObject;
  static inline const std::string name = "FrameLatest";
  static inline Function Init(Napi::Env env) {
    auto iterator = Napi::Symbol::WellKnown(env, "iterator");
    return DefineClass(env, FrameLatestIter::name.c_str(),
                       {
                           CORE_OBJECT_REGISTER(FrameLatestIter, env),        //
                           InstanceMethod<&FrameLatestIter::self>(iterator),  //
                           InstanceMethod<&FrameLatestIter::next>("next"),    //
                           InstanceMethod<&FrameLatestIter::close>("return"), //
                           InstanceMethod<&FrameLatestIter::close>("throw"),  //
                       });
  }

private:
  FN(self) { return info.This(); }
  FN(next) { return core()->next(info); }
  FN(close) { return core()->close(info); }
};

CORE_OBJECT(FrameLatest::Ptr, FrameLatestIter);
