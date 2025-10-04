// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "napi.h"
#include "utils/pointer.h"
#include "utils/stacktrace.h"
#include <exception>
#include <functional>
#include <sstream>

#define FN(NAME) Napi::Value NAME(const Napi::CallbackInfo &info)
#define GET(NAME) FN(get_##NAME)
#define SET(NAME)                                                              \
  void set_##NAME(const Napi::CallbackInfo &info, const Napi::Value &val)

#define INSTANCE_METHOD(CLS, NAME) InstanceMethod<&CLS::NAME>(#NAME)
#define INSTANCE_GETTER(CLS, NAME)                                             \
  InstanceAccessor<&CLS::get_##NAME>(#NAME, napi_enumerable)
#define INSTANCE_ACCESSOR(CLS, NAME)                                           \
  InstanceAccessor<&CLS::get_##NAME, &CLS::set_##NAME>(                        \
      #NAME, (napi_property_attributes)(napi_writable | napi_enumerable))

inline const Napi::Error &injectNativeStack(const Napi::Error &error,
                                            std::string stacktrace) {
  std::stringstream ss;
  ss << error.Value().Get("stack").ToString().Utf8Value() << std::endl
     << std::endl
     << "==== Native Stack ====" << std::endl
     << stacktrace;
  error.Value().Set("stack", Napi::String::New(error.Env(), ss.str()));
  return error;
}

inline const Napi::Error injectNativeStack(const Napi::Error error) {
  return injectNativeStack(error, Stacktrace::capture());
}

#define JS_THROW(ERR, MSG)                                                     \
  {                                                                            \
    auto error = Napi::Error::New(env, MSG);                                   \
    injectNativeStack(error).ThrowAsJavaScriptException();                     \
    return;                                                                    \
  }

#define JS_THROW_RET(ERR, MSG, RET)                                            \
  {                                                                            \
    auto error = Napi::Error::New(env, MSG);                                   \
    injectNativeStack(error).ThrowAsJavaScriptException();                     \
    return RET;                                                                \
  }

#define JS_ASSERT(COND, ERR, MSG)                                              \
  if (!(COND))                                                                 \
    JS_THROW(ERR, MSG);

#define JS_ASSERT_RET(COND, ERR, MSG, RET)                                     \
  if (!(COND))                                                                 \
    JS_THROW_RET(ERR, MSG, RET);

#define JS_EXCEPT(CODE)                                                        \
  try {                                                                        \
    CODE;                                                                      \
  } catch (JS::Error & e) {                                                    \
    e.Throw();                                                                 \
  } catch (const std::exception &e) {                                          \
    JS_THROW(Error, e.what());                                                 \
  }

#define JS_EXCEPT_RET(CODE, RET)                                               \
  try {                                                                        \
    CODE;                                                                      \
  } catch (JS::Error & e) {                                                    \
    e.Throw();                                                                 \
    return RET;                                                                \
  } catch (const std::exception &e) {                                          \
    JS_THROW_RET(Error, e.what(), RET);                                        \
  }

#if defined(DEBUG) || defined(_DEBUG)
#include <cstdio>
#define VERBOSE(...)                                                           \
  {                                                                            \
    std::fprintf(stderr, "[FoveaCam] " __VA_ARGS__);                           \
    std::putc('\n', stderr);                                                   \
    std::fflush(stderr);                                                       \
  }
#else
#define VERBOSE(MSG)
#endif

namespace JS {

class Error : public std::exception {
  const Napi::Error error;

public:
  Error(Napi::Error error) : error(injectNativeStack(error)) {}
  Error(Napi::Env env, std::string message)
      : error(injectNativeStack(
            Napi::Error::New(env, Napi::String::New(env, message)))) {}
  void Throw() const { error.ThrowAsJavaScriptException(); }
  const char *what() const noexcept override { return error.Message().c_str(); }
};

class TypeError : public Error {
  const Napi::Error error;

public:
  TypeError(Napi::Env env, std::string message)
      : Error(Napi::TypeError::New(env, Napi::String::New(env, message))) {}
};

class RangeError : public Error {
  const Napi::Error error;

public:
  RangeError(Napi::Env env, std::string message)
      : Error(Napi::RangeError::New(env, Napi::String::New(env, message))) {}
};

} // namespace JS

#include "utils/type-name.h"

template <typename T> inline T noNull(T ptr, std::string message) {
  if (!ptr)
    throw std::runtime_error(message);
  return ptr;
}

template <typename T> inline T noNull(T ptr) {
  return noNull(ptr, "Pointer of type " + type_name<T>() + " is null");
}

/**
 * Extracts the raw pointer from a Napi::Value which is expected to be an
 * External<T>.
 * nullptr may be returned from this function upon unexpected input.
 */
template <typename T> T &extract(const Napi::Value &value, std::string action) {
  const auto env = value.Env();
  if (!value.IsExternal())
    throw JS::TypeError(env, "Cannot " + action + " from JS");
  auto ptr = value.As<Napi::External<T>>().Data();
  if (!ptr)
    throw JS::Error(env, "Null pointer extracted: " + action);
  return *ptr;
}

template <typename T> T &extract(const Napi::Value &value) {
  static const auto type = type_name<T>();
  return extract<T>(value, "extract " + type);
}

template <SmartPtrLike R> class OneShotWorker : public Napi::AsyncWorker {
  // typedef R (*Workload)(Arg *arg);
  using Fn = std::function<R()>;
  Napi::Env const env;
  Fn const fn;
  R result;
  Napi::Value container;
  std::string stacktrace;
  const Napi::Promise::Deferred deferred;
  OneShotWorker(Napi::Env env, Fn fn)
      : Napi::AsyncWorker(env), env(env), fn(fn), container(env.Undefined()),
        deferred(Napi::Promise::Deferred::New(env)) {}
  OneShotWorker(Napi::Env env, Fn fn, Napi::Value container)
      : Napi::AsyncWorker(env), env(env), fn(fn), container(container),
        deferred(Napi::Promise::Deferred::New(env)) {}
  void Execute() override {
    try {
      result = fn();
    } catch (const std::exception &e) {
      stacktrace = Stacktrace::capture();
      SetError(e.what());
    } catch (...) {
      stacktrace = Stacktrace::capture();
      SetError("Unknown error");
    }
  }
  void OnOK() override { deferred.Resolve(CreateObject(container, result)); }
  void OnError(const Napi::Error &e) override {
    deferred.Reject(injectNativeStack(e, stacktrace).Value());
  }

public:
  static inline Napi::Promise run(Napi::Env env, Fn fn) {
    auto worker = new OneShotWorker(env, fn);
    auto promise = worker->deferred.Promise();
    worker->Queue();
    return promise;
  }
};

inline Napi::Object IterNext(Napi::Env env, Napi::Value value) {
  auto obj = Napi::Object::New(env);
  obj.Set("value", value);
  obj.Set("done", Napi::Boolean::New(env, false));
  return obj;
}

inline Napi::Object IterNext(Napi::Env env) {
  auto obj = Napi::Object::New(env);
  obj.Set("value", env.Undefined());
  obj.Set("done", Napi::Boolean::New(env, true));
  return obj;
}
