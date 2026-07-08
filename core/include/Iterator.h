// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <Aravis/Frame.h>
#include <Aravis/Stream.h>
#include <Stream/Stream.h>
#include <Threading/Guard.h>
#include <condition_variable>
#include <pointer.h>
#include <queue>
#include <stdexcept>

#include "CoreObject.h"
#include "Dispatcher.h"
#include "napi-helper.h"
#include "type_name.h"

namespace Sub {

using namespace Dispatcher;

template <SmartPtrLike T>
class Queue : public Subscriber<T>, public Shared<Queue<T>> {
public:
  using Subscriber<T>::Subscriber;
  static inline const std::string NAME =
      "Subscriber<" + type_name<T>() + ">::Queue";
  static constexpr size_t MAX_BUFFERED = 8;

private:
  // Push-pull data model. Only one of data_queue or future_queue is
  // non-empty at any time.
  struct Data {
    // Holds incoming data
    std::queue<T> data_queue;
    // Holds pending futures
    std::queue<Future::Ptr> future_queue;
    size_t dropped = 0;
  };
  // Guarded access ensures thread safety
  Threading::Guard<Data> data;

  void push(const T &value) override {
    auto ref = data.ref();
    if (ref->future_queue.empty()) {
      if (ref->data_queue.size() >= MAX_BUFFERED) {
        ref->data_queue.pop();
        ref->dropped++;
        WARN("%s dropped stale queued frame (%zu total)", NAME.c_str(),
             ref->dropped);
      }
      ref->data_queue.push(value);
      VERBOSE("%s::push(%p) -> data queue [%p]", NAME.c_str(), value.get(),
              &ref->data_queue.back());
    } else {
      auto &future = ref->future_queue.front();
      VERBOSE("%s::push(%p) -> Future[%p]", NAME.c_str(), value.get(),
              future.get());
      auto task = [future, value](Napi::Env env) {
        VERBOSE("Resolving Future[%p] with %s[%p]", future.get(),
                type_name<T>().c_str(), value.get());
        future->Resolve(IterNext(env, convert(env, value)));
      };
      ref->future_queue.pop();
      ref.release();
      dispatch(future->Env(), task);
    }
  };
  void close(bool unsubscribe, TracedError::Ptr err) override {
    VERBOSE("%s::close()", NAME.c_str());
    Subscriber<T>::close(unsubscribe, err);
    auto ref = data.ref();
    if (err) {
      while (!ref->future_queue.empty()) {
        auto &future = ref->future_queue.front();
        auto task = [future, err](Napi::Env env) {
          auto error = Napi::Error::New(env, err->what());
          injectNativeStack(error, err->stack);
          future->Reject(error.Value());
        };
        ref->future_queue.pop();
        ref.release();
        dispatch(future->Env(), task);
      }
    } else {
      while (!ref->future_queue.empty()) {
        auto &future = ref->future_queue.front();
        auto task = [future](Napi::Env env) { future->Resolve(IterNext(env)); };
        ref->future_queue.pop();
        ref.release();
        dispatch(future->Env(), task);
      }
    }
  };

public:
  FN(next) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto promise = deferred.Promise();
    auto ref = data.ref();
    if (!ref->data_queue.empty()) {
      auto value = std::move(ref->data_queue.front());
      ref->data_queue.pop();
      ref.release();
      VERBOSE("%s::next(%p)", NAME.c_str(), value.get());
      deferred.Resolve(IterNext(env, convert(env, std::move(value))));
    } else {
      ref->future_queue.push(Future::create(std::move(deferred)));
      VERBOSE("%s::next(pending) -> Future[%p]", NAME.c_str(),
              ref->future_queue.back().get());
      ref.release();
    }
    return promise;
  };
  FN(stop) {
    VERBOSE("%s::stop([From JS])", NAME.c_str());
    Subscriber<T>::close();
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    deferred.Resolve(IterNext(env));
    return deferred.Promise();
  };
};

template <typename T>
// Synchronous iterator that always returns the latest frame
class Latest : public Subscriber<T>, public Shared<Latest<T>> {
public:
  using Subscriber<T>::Subscriber;
  static inline const std::string NAME =
      "Subscriber<" + type_name<T>() + ">::Latest";

private:
  Threading::Guard<T> data = {nullptr};
  std::condition_variable signal;
  // Frames overwritten before they were consumed — a latest-wins "drop". The
  // count is the load-bearing "the consumer can't keep up" signal (e.g. the
  // 1d KCF thread falling behind the camera fps); metered off it. Written on
  // the producing stream's thread, read (delta) by the consumer's thread.
  std::atomic<uint64_t> dropped_{0};
  void push(const T &value) override {
    {
      auto ref = data.ref();
      if (*ref != nullptr) // overwriting an unconsumed frame == a drop
        dropped_.fetch_add(1, std::memory_order_relaxed);
      *ref = value;
    }
    signal.notify_all();
  };

public:
  uint64_t droppedCount() const {
    return dropped_.load(std::memory_order_relaxed);
  }

private:
  void close(bool unsubscribe = true, TracedError::Ptr err = nullptr) override {
    Subscriber<T>::close(unsubscribe, err);
    signal.notify_all();
  }

public:
  inline T peek() { return *data.ref(); }
  inline T consume() {
    auto ref = data.ref();
    auto v = *ref;
    *ref = nullptr;
    return v;
  }
  inline T wait() {
    auto ref = data.ref();
    if (!*ref)
      ref.wait(signal);
    auto v = *ref;
    *ref = nullptr;
    return v;
  }

  FN(next) {
    auto env = info.Env();
    {
      auto ref = data.ref();
      auto latest = *ref;
      if (latest) {
        *ref = nullptr; // Clear after reading
        VERBOSE("%s::next(%p)", NAME.c_str(), latest.get());
        return IterNext(env, convert(env, latest));
      }
    }
    // No new frame, check if still active
    const auto s = Subscriber<T>::state.snapshot();
    if (s.isActive()) {
      VERBOSE("%s::next(null)", NAME.c_str());
      return IterNext(env, env.Null());
    } else if (s.error) {
      auto &message = s.error->message;
      auto &stack = s.error->stack;
      auto error = Napi::Error::New(env, message);
      injectNativeStack(error, stack);
      error.ThrowAsJavaScriptException();
      VERBOSE("%s::next(error)", NAME.c_str());
      return env.Undefined();
    } else {
      VERBOSE("%s::next(done)", NAME.c_str());
      return IterNext(env); // Iteration complete
    }
  };
  FN(stop) {
    VERBOSE("%s::stop()", NAME.c_str());
    auto env = info.Env();
    Subscriber<T>::close();
    return IterNext(env);
  };
  GET(current) {
    auto env = info.Env();
    auto ref = data.ref();
    auto &latest = *ref;
    return latest ? convert(env, latest) : env.Null();
  };
};

template <typename Sub, SmartPtrLike Ptr = Sub::Ptr>
class Iterator : public CoreObject<Iterator<Sub>, Ptr> {
  CORE_OBJECT_DECL(Iterator<Sub>);

public:
  using CoreObject<Iterator<Sub>, Ptr>::CoreObject;
  static inline const std::string name = "Iterator<" + type_name<Sub>() + ">";
  static inline Napi::Function Init(Napi::Env env) {
    auto iterator = Napi::Symbol::WellKnown(env, "iterator");
    return CoreObject<Iterator<Sub>, Ptr>::DefineClass(
        env, Iterator<Sub>::name.c_str(),
        {
            CORE_OBJECT_REGISTER(Iterator<Sub>, env),       //
            Napi::InstanceWrap<Iterator<Sub>>::template     //
            InstanceMethod<&Iterator<Sub>::self>(iterator), //
            Napi::InstanceWrap<Iterator<Sub>>::template     //
            InstanceMethod<&Iterator<Sub>::next>("next"),   //
            Napi::InstanceWrap<Iterator<Sub>>::template     //
            InstanceMethod<&Iterator<Sub>::stop>("return"), //
            Napi::InstanceWrap<Iterator<Sub>>::template     //
            InstanceMethod<&Iterator<Sub>::stop>("throw"),  //
        });
  }

private:
  FN(self) { return info.This(); }
  FN(next) {
    auto env = info.Env();
    try {
      return CoreObject<Iterator<Sub>, Ptr>::core()->next(info);
    }
    JS_EXCEPT(env.Undefined())
  }
  FN(stop) {
    auto env = info.Env();
    try {
      return CoreObject<Iterator<Sub>, Ptr>::core()->stop(info);
    }
    JS_EXCEPT(env.Undefined())
  }
};

} // namespace Sub

template <SmartPtrLike I, SmartPtrLike O>
class TransformStream : public Stream<O> {
public:
  using Stream<O>::Stream;
  virtual ~TransformStream() { Stream<O>::assert_shutdown_called(); }

private:
  Sub::Latest<I>::Ptr sub = nullptr;
  void start() override { sub = Sub::Latest<I>::create(upstream()); }
  void stop() override { sub = nullptr; }
  O iterate() override {
    auto sub = this->sub;
    if (!sub)
      throw std::runtime_error("TransformStream<" + type_name<I>() + ", " +
                               type_name<O>() + "> upstream not available");
    I input = sub->wait();
    if (input != nullptr) {
      return transform(input);
    } else {
      auto state = sub->state.snapshot();
      if (state.isActive()) {
        return nullptr;
      } else if (state.error) {
        throw *state.error;
      } else {
        throw StopIteration();
      }
    }
  }

protected:
  virtual Stream<I> *upstream() = 0;
  virtual O transform(const I &input) = 0;

  // Cumulative upstream frames dropped by the latest-wins handoff (frames that
  // arrived while `transform` was busy). A subclass reads the delta each
  // `transform` to meter "producer outran the transform". Valid once started.
  uint64_t upstreamDrops() const { return sub ? sub->droppedCount() : 0; }
};

template <typename S, SmartPtrLike P = S::Ptr>
class StreamObject : public CoreObject<StreamObject<S, P>, P> {
  CORE_OBJECT_DECL(StreamObject);

public:
  using Payload = typename S::Payload;
  using CoreObject<StreamObject<S, P>, P>::CoreObject;
  static inline const std::string name = "Stream<" + type_name<Payload>() + ">";
  static inline Napi::Function Init(Napi::Env env) {
    auto iterator = Napi::Symbol::WellKnown(env, "iterator");
    auto asyncIterator = Napi::Symbol::WellKnown(env, "asyncIterator");
    auto fn = CoreObject<StreamObject<S, P>, P>::DefineClass(
        env, StreamObject::name.c_str(),
        {
            CORE_OBJECT_REGISTER(StreamObject, env),                      //
            Napi::InstanceWrap<StreamObject>::template                    //
            InstanceMethod<&StreamObject::iterator>(iterator),            //
            Napi::InstanceWrap<StreamObject>::template                    //
            InstanceMethod<&StreamObject::async_iterator>(asyncIterator), //
        });
    return fn;
  }

  FN(iterator) {
    auto env = info.Env();
    try {
      using namespace Arv;
      using namespace Sub;
      auto stream = StreamObject::core().get();
      auto latest = Latest<Payload>::create(stream);
      VERBOSE("Created Latest Iterator for Stream<%s> @ %p",
              type_name<Payload>().c_str(),
              CoreObject<StreamObject<S, P>, P>::core().get());
      Napi::Value iterator = Iterator<Latest<Payload>>::Create(env, latest);
      if (iterator.IsObject())
        iterator.As<Napi::Object>().Set("upstream", info.This());
      return iterator;
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(async_iterator) {
    auto env = info.Env();
    try {
      using namespace Arv;
      using namespace Sub;
      auto stream = StreamObject::core().get();
      auto queue = Queue<Payload>::create(stream);
      VERBOSE("Created Queue Iterator for Stream<%s> @ %p",
              type_name<Payload>().c_str(),
              CoreObject<StreamObject<S, P>, P>::core().get());
      Napi::Value iterator = Iterator<Queue<Payload>>::Create(env, queue);
      if (iterator.IsObject())
        iterator.As<Napi::Object>().Set("upstream", info.This());
      return iterator;
    }
    JS_EXCEPT(env.Undefined())
  }

  // TODO
  // GET(active) {}
  // SET(active) {}
};
