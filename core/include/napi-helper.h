// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "Dispatcher.h"
#include <iostream>
#include <napi.h>

#include <sstream>

#include <Threading/Guard.h>
#include <pointer.h>
#include <type_name.h>
#include <utils/debug.h>
#include <utils/error.h>
#include <utils/map-set.h>
#include <utils/stacktrace.h>

#define FN(NAME) Napi::Value NAME(const Napi::CallbackInfo &info)
#define GET(NAME) FN(get_##NAME)
#define SET(NAME)                                                              \
  void set_##NAME(const Napi::CallbackInfo &info, const Napi::Value &val)

#define INSTANCE_METHOD(CLS, NAME)                                             \
  Napi::InstanceWrap<CLS>::template InstanceMethod<&CLS::NAME>(#NAME)
#define INSTANCE_GETTER(CLS, NAME)                                             \
  Napi::InstanceWrap<CLS>::template InstanceAccessor<&CLS::get_##NAME>(        \
      #NAME, napi_enumerable)
#define INSTANCE_ACCESSOR(CLS, NAME)                                           \
  Napi::InstanceWrap<CLS>::template InstanceAccessor<&CLS::get_##NAME,         \
                                                     &CLS::set_##NAME>(        \
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

#define JS_EXCEPT(...)                                                         \
  catch (JS::ErrorBase & e) {                                                  \
    e.Throw();                                                                 \
    return __VA_ARGS__;                                                        \
  }                                                                            \
  catch (const std::exception &e) {                                            \
    JS_THROW(Error, e.what(), __VA_ARGS__);                                    \
  }                                                                            \
  catch (...) {                                                                \
    JS_THROW(Error, "Unknown error occurred", __VA_ARGS__);                    \
  }

template <typename D>
class Isolated : private Threading::Guard<Map<napi_env, D>> {
public:
  D &get(Napi::Env env) {
    auto ref = this->ref();
    if (!ref->has(env)) {
      ref->set(env, D());
      env.AddCleanupHook([this](napi_env env) { this->ref()->erase(env); },
                         static_cast<napi_env>(env));
    }
    return ref->get(env);
  }
};

namespace JS {

class ErrorBase : public TracedError {
  virtual Napi::Error createJsError() const = 0;
  mutable std::string full_message = "";

public:
  Napi::Env const env;
  inline ErrorBase(Napi::Env env, std::string message)
      : TracedError(message), env(env) {};
  inline Napi::Error error() const {
    return injectNativeStack(createJsError(), stack);
  }
  void Throw() const { error().ThrowAsJavaScriptException(); }
  const char *what() const noexcept override {
    auto e = createJsError();
    full_message = e.Value().Get("stack").ToString().Utf8Value() +
                   "\n\n==== Native Stack ====\n" + stack;
    return full_message.c_str();
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

#include <convert.h>

template <typename T>
inline T optionalArgument(const Napi::Value &arg, T &&fallback) {
  if (arg.IsUndefined() || arg.IsNull())
    return std::forward<T>(fallback);
  return convert<std::remove_reference_t<T>>(arg);
}

inline Napi::Value optionalArgument(const Napi::Value &arg) {
  if (arg.IsUndefined() || arg.IsNull())
    return arg.Env().Undefined();
  return arg;
}

// Conversion from native C++ type to Napi::Value
// C++ Exceptions should be translated to JS Exceptions.
template <typename... Args>
Napi::Value convert(Napi::Env, const Args &...) noexcept;

inline Napi::Object IterNext(Napi::Env env, Napi::Value &&value) {
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

std::string repr(const Napi::Value &value, int max_depth = 3,
                 int __internal__ = 0);

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

template <typename T> class ThreadSafeReference {
private:
  const Napi::Env env;
  const Napi::Reference<T> *ref;

public:
  ThreadSafeReference(T &value)
      : env(value.Env()),
        ref(new Napi::Reference<T>(env, Napi::Persistent(value))) {
    VERBOSE("[ThreadSafeReference] Created @ %p", ref);
  }
  ~ThreadSafeReference() {
    if (ref)
      Dispatcher::dispatch(env, [ref = ref](napi_env) {
        VERBOSE("[ThreadSafeReference] Destroyed @ %p", ref);
        delete ref;
      });
  }
};

// Conversion between JS value and native value

#define CONVERT_ARRAY_OF(EL, ...)                                              \
  template <> std::vector<EL> __VA_ARGS__ convert(const Napi::Value &value) {  \
    if (!value.IsArray())                                                      \
      throw JS::TypeError(                                                     \
          value.Env(),                                                         \
          "Argument must be an array (converting array of " #EL ")");          \
    auto arr = value.As<Napi::Array>();                                        \
    std::vector<EL> result;                                                    \
    result.reserve(arr.Length());                                              \
    for (size_t i = 0; i < arr.Length(); ++i) {                                \
      result.push_back(convert<EL>(arr.Get(i)));                               \
    }                                                                          \
    return result;                                                             \
  }                                                                            \
  template <>                                                                  \
  Napi::Value __VA_ARGS__ convert(Napi::Env env,                               \
                                  const std::vector<EL> &value) noexcept {     \
    auto arr = Napi::Array::New(env, value.size());                            \
    for (size_t i = 0; i < value.size(); ++i) {                                \
      arr.Set(i, convert(env, value[i]));                                      \
    }                                                                          \
    return arr;                                                                \
  };                                                                           \
  template <>                                                                  \
  Napi::Value __VA_ARGS__ convert(Napi::Env env, const Napi::Value &container, \
                                  const std::vector<EL> &value) noexcept {     \
    if (container.IsArray()) {                                                 \
      const auto &arr = container.As<Napi::Array>();                           \
      for (const auto &el : value)                                             \
        arr.Set(arr.Length(), convert(env, el));                               \
      return arr;                                                              \
    } else {                                                                   \
      return convert(env, value);                                              \
    }                                                                          \
  };

template <> inline std::string convert(const Napi::Value &value) {
  return value.ToString().Utf8Value();
}

template <>
inline Napi::Value convert(Napi::Env env, const std::string &value) noexcept {
  return Napi::String::New(env, value);
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const std::string &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(std::string, inline);

template <> inline bool convert(const Napi::Value &value) {
  return value.ToBoolean().Value();
}

template <>
inline Napi::Value convert(Napi::Env env, const bool &value) noexcept {
  return Napi::Boolean::New(env, value);
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const bool &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(bool, inline);

template <> inline uint8_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Uint32Value();
  if (v > UINT8_MAX)
    throw JS::Error(value.Env(),
                    "Value " + std::to_string(v) + " out of range for uint8.");
  return static_cast<uint8_t>(v);
}

template <>
inline Napi::Value convert(Napi::Env env, const uint8_t &value) noexcept {
  return Napi::Number::New(env, static_cast<double>(value));
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const uint8_t &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(uint8_t, inline);

template <> inline int8_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Int32Value();
  if (v < INT8_MIN || v > INT8_MAX)
    throw JS::Error(value.Env(),
                    "Value " + std::to_string(v) + " out of range for int8.");
  return static_cast<int8_t>(v);
}

template <>
inline Napi::Value convert(Napi::Env env, const int8_t &value) noexcept {
  return Napi::Number::New(env, static_cast<double>(value));
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const int8_t &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(int8_t, inline);

template <> inline uint16_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Uint32Value();
  if (v > UINT16_MAX)
    throw JS::Error(value.Env(),
                    "Value " + std::to_string(v) + " out of range for uint16.");
  return static_cast<uint16_t>(v);
}

template <>
inline Napi::Value convert(Napi::Env env, const uint16_t &value) noexcept {
  return Napi::Number::New(env, static_cast<double>(value));
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const uint16_t &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(uint16_t, inline);

template <> inline int16_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Int32Value();
  if (v < INT16_MIN || v > INT16_MAX)
    throw JS::Error(value.Env(),
                    "Value " + std::to_string(v) + " out of range for int16.");
  return static_cast<int16_t>(v);
}

template <>
inline Napi::Value convert(Napi::Env env, const int16_t &value) noexcept {
  return Napi::Number::New(env, static_cast<double>(value));
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const int16_t &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(int16_t, inline);

template <> inline uint32_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Uint32Value();
  return static_cast<uint32_t>(v);
}

template <>
inline Napi::Value convert(Napi::Env env, const uint32_t &value) noexcept {
  return Napi::Number::New(env, static_cast<double>(value));
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const uint32_t &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(uint32_t, inline);

template <> inline int32_t convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().Int32Value();
  return static_cast<int32_t>(v);
}

template <>
inline Napi::Value convert(Napi::Env env, const int32_t &value) noexcept {
  return Napi::Number::New(env, static_cast<double>(value));
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const int32_t &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(int32_t, inline);

template <> inline uint64_t convert(const Napi::Value &value) {
  if (value.IsNumber()) {
    auto v = value.As<Napi::Number>().Uint32Value();
    return static_cast<uint64_t>(v);
  }
  if (value.IsBigInt()) {
    bool lossless = false;
    auto v = value.As<Napi::BigInt>().Uint64Value(&lossless);
    if (!lossless)
      throw JS::Error(value.Env(), "BigInt value is too large for uint64.");
    return static_cast<uint64_t>(v);
  }
  throw JS::TypeError(value.Env(), "Value cannot be converted to uint64.");
}

template <>
inline Napi::Value convert(Napi::Env env, const uint64_t &value) noexcept {
  return Napi::BigInt::New(env, value);
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const uint64_t &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(uint64_t, inline);

template <> inline int64_t convert(const Napi::Value &value) {
  if (value.IsNumber()) {
    auto v = value.As<Napi::Number>().Int32Value();
    return static_cast<int64_t>(v);
  }
  if (value.IsBigInt()) {
    bool lossless = false;
    auto v = value.As<Napi::BigInt>().Int64Value(&lossless);
    if (!lossless)
      throw JS::Error(value.Env(), "BigInt value is too large for int64.");
    return static_cast<int64_t>(v);
  }
  throw JS::TypeError(value.Env(), "Value cannot be converted to int64.");
}

template <>
inline Napi::Value convert(Napi::Env env, const int64_t &value) noexcept {
  return Napi::BigInt::New(env, value);
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const int64_t &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(int64_t, inline);

template <> inline float convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().FloatValue();
  return static_cast<float>(v);
}

template <>
inline Napi::Value convert(Napi::Env env, const float &value) noexcept {
  return Napi::Number::New(env, static_cast<double>(value));
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const float &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(float, inline);

template <> inline double convert(const Napi::Value &value) {
  if (!value.IsNumber())
    throw JS::TypeError(value.Env(), "Value is not a number");
  auto v = value.As<Napi::Number>().DoubleValue();
  return static_cast<double>(v);
}

template <>
inline Napi::Value convert(Napi::Env env, const double &value) noexcept {
  return Napi::Number::New(env, static_cast<double>(value));
}

template <>
inline Napi::Value convert(Napi::Env env, const Napi::Value &container,
                           const double &value) noexcept {
  return convert(env, value);
}

CONVERT_ARRAY_OF(double, inline);
