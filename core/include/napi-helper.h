// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <napi.h>

#include <exception>
#include <functional>
#include <sstream>

#include <pointer.h>
#include <type_name.h>
#include <utils/debug.h>
#include <utils/error.h>
#include <utils/stacktrace.h>

#define FN(NAME) Napi::Value NAME(const Napi::CallbackInfo &info)
#define GET(NAME) FN(get_##NAME)
#define SET(NAME)                                                              \
  void set_##NAME(const Napi::CallbackInfo &info, const Napi::Value &val)

#define INSTANCE_METHOD(CLS, NAME)                                             \
  InstanceWrap<CLS>::template InstanceMethod<&CLS::NAME>(#NAME)
#define INSTANCE_GETTER(CLS, NAME)                                             \
  InstanceWrap<CLS>::template InstanceAccessor<&CLS::get_##NAME>(              \
      #NAME, napi_enumerable)
#define INSTANCE_ACCESSOR(CLS, NAME)                                           \
  InstanceWrap<CLS>::template InstanceAccessor<&CLS::get_##NAME,               \
                                               &CLS::set_##NAME>(              \
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

#define JS_THROW(ERR, MSG, ...)                                                \
  {                                                                            \
    auto error = Napi::Error::New(env, MSG);                                   \
    injectNativeStack(error, Stacktrace::capture())                            \
        .ThrowAsJavaScriptException();                                         \
    return __VA_ARGS__;                                                        \
  }

#define JS_ASSERT(COND, ERR, MSG, ...)                                         \
  if (!(COND))                                                                 \
    JS_THROW(ERR, MSG, __VA_ARGS__);

#define JS_EXCEPT(CODE, ...)                                                   \
  try {                                                                        \
    CODE;                                                                      \
  } catch (JS::ErrorBase & e) {                                                \
    e.Throw();                                                                 \
    return __VA_ARGS__;                                                        \
  } catch (const std::exception &e) {                                          \
    JS_THROW(Error, e.what(), __VA_ARGS__);                                    \
  } catch (...) {                                                              \
    JS_THROW(Error, "Unknown error occurred", __VA_ARGS__);                    \
  }

namespace JS {

class ErrorBase : public TracedError {
  virtual Napi::Error createJsError() const = 0;

public:
  Napi::Env const env;
  inline ErrorBase(Napi::Env env, std::string message)
      : TracedError(message), env(env) {};
  void Throw() const {
    auto e = injectNativeStack(createJsError(), stack);
    e.ThrowAsJavaScriptException();
  }
};

class Error : public ErrorBase {
  Napi::Error createJsError() const override {
    return Napi::Error::New(env, Napi::String::New(env, message));
  }

public:
  using ErrorBase::ErrorBase;
};

class TypeError : public ErrorBase {
  Napi::Error createJsError() const override {
    return Napi::TypeError::New(env, Napi::String::New(env, message));
  }

public:
  using ErrorBase::ErrorBase;
};

} // namespace JS

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

template <typename T> void deleter(Napi::Env, void *, void *hint) {
  if (hint) {
    delete static_cast<T *>(hint);
    auto name = type_name<T>();
    VERBOSE("[deleter] Collected: %.*s %p", static_cast<int>(name.size()),
            name.data(), hint);
  } else {
    throw std::runtime_error("Got null deleter hint pointer");
  }
}

template <typename... Args> Napi::Value convert(Napi::Env, const Args &...);

template <typename T>
Napi::Value convert(Napi::Env, const Napi::Value &container, const T &value) {
  return CreateObject(container, value);
}

template <typename R> class OneShotWorker : public Napi::AsyncWorker {
  static inline const std::string NAME = type_name<OneShotWorker>();
  // To be executed in worker thread, performs the actual task
  using Task = std::function<R()>;
  Napi::Env const env;
  Task const task;
  // const Napi::Value container;
  const Napi::Reference<Napi::Value> container;
  const Napi::Promise::Deferred deferred;
  R result;
  std::string stacktrace;
  OneShotWorker(Napi::Env env, Task task)
      : Napi::AsyncWorker(env), env(env), task(task), container(),
        deferred(Napi::Promise::Deferred::New(env)) {}
  OneShotWorker(const Napi::Value &container, Task task)
      : Napi::AsyncWorker(container.Env()), env(container.Env()), task(task),
        container(Napi::Persistent(container)),
        deferred(Napi::Promise::Deferred::New(env)) {}
  void Execute() override {
    try {
      result = task();
    } catch (const std::exception &e) {
      stacktrace = Stacktrace::capture();
      SetError(e.what());
    } catch (...) {
      stacktrace = Stacktrace::capture();
      SetError("Unknown error");
    }
  }
  void OnOK() override {
    auto container =
        this->container.IsEmpty() ? env.Undefined() : this->container.Value();
    deferred.Resolve(convert(env, container, result));
  }
  void OnError(const Napi::Error &e) override {
    deferred.Reject(injectNativeStack(e, stacktrace).Value());
  }

public:
  static inline Napi::Promise run(Napi::Env env, Task task) {
    auto worker = new OneShotWorker(env, task);
    auto promise = worker->deferred.Promise();
    worker->Queue();
    return promise;
  }
  static inline Napi::Promise run(const Napi::Value &container, Task task) {
    if (container.IsUndefined() || container.IsNull())
      return run(container.Env(), task);
    auto worker = new OneShotWorker(container, task);
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

#include <convert.h>

template <> inline std::string convert(const napi_valuetype &value) {
  switch (value) {
  case napi_undefined:
    return "undefined";
  case napi_null:
    return "null";
  case napi_boolean:
    return "boolean";
  case napi_number:
    return "number";
  case napi_string:
    return "string";
  case napi_symbol:
    return "symbol";
  case napi_object:
    return "object";
  case napi_function:
    return "function";
  case napi_external:
    return "external";
  case napi_bigint:
    return "bigint";
  default:
    return "unknown";
  }
}

inline bool isBufferLike(const Napi::Value &value) {
  return value.IsBuffer() || value.IsArrayBuffer() || value.IsTypedArray() ||
         value.IsDataView();
}

#include <Buffer/Buffer.h>

template <typename T = uint8_t>
inline Buffer<T> bufferView(const Napi::Value &value) {
  if (value.IsBuffer()) {
    auto b = value.As<Napi::Buffer<T>>();
    return {b.Data(), b.Length()};
  }
  if (value.IsArrayBuffer()) {
    auto b = value.As<Napi::ArrayBuffer>();
    size_t byteLength = b.ByteLength();
    if constexpr (sizeof(T) > 1) {
      if (byteLength % sizeof(T) != 0) {
        throw JS::TypeError(
            value.Env(), "ArrayBuffer size is not a multiple of element size");
      }
    }
    return {static_cast<T *>(b.Data()), byteLength / sizeof(T)};
  }
  if (value.IsTypedArray()) {
    auto t = value.As<Napi::TypedArray>();
    auto b = t.ArrayBuffer();
    size_t byteOffset = t.ByteOffset();
    size_t byteLength = t.ByteLength();
    if constexpr (sizeof(T) > 1) {
      if (byteLength % sizeof(T) != 0) {
        throw JS::TypeError(
            value.Env(), "TypedArray size is not a multiple of element size");
      }
    }
    return {
        reinterpret_cast<T *>(static_cast<uint8_t *>(b.Data()) + byteOffset),
        byteLength / sizeof(T)};
  }
  if (value.IsDataView()) {
    auto d = value.As<Napi::DataView>();
    auto b = d.ArrayBuffer();
    size_t byteOffset = d.ByteOffset();
    size_t byteLength = d.ByteLength();
    if constexpr (sizeof(T) > 1) {
      if (byteLength % sizeof(T) != 0) {
        throw JS::TypeError(value.Env(),
                            "DataView size is not a multiple of element size");
      }
    }
    return {
        reinterpret_cast<T *>(static_cast<uint8_t *>(b.Data()) + byteOffset),
        byteLength / sizeof(T)};
  }
  throw JS::TypeError(value.Env(), "Value is not buffer-like");
}

// Conversion from JS value to native value
template <> inline uint8_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Uint32Value();
  if (v > UINT8_MAX)
    throw JS::Error(value.Env(),
                    "Value " + std::to_string(v) + " out of range for uint8.");
  return static_cast<uint8_t>(v);
}

template <> inline int8_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Int32Value();
  if (v < INT8_MIN || v > INT8_MAX)
    throw JS::Error(value.Env(),
                    "Value " + std::to_string(v) + " out of range for int8.");
  return static_cast<int8_t>(v);
}

template <> inline uint16_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Uint32Value();
  if (v > UINT16_MAX)
    throw JS::Error(value.Env(),
                    "Value " + std::to_string(v) + " out of range for uint16.");
  return static_cast<uint16_t>(v);
}

template <> inline int16_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Int32Value();
  if (v < INT16_MIN || v > INT16_MAX)
    throw JS::Error(value.Env(),
                    "Value " + std::to_string(v) + " out of range for int16.");
  return static_cast<int16_t>(v);
}

template <> inline uint32_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Uint32Value();
  return static_cast<uint32_t>(v);
}

template <> inline int32_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Int32Value();
  return static_cast<int32_t>(v);
}

template <> inline float convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().FloatValue();
  return static_cast<float>(v);
}

template <> inline double convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().DoubleValue();
  return static_cast<double>(v);
}
