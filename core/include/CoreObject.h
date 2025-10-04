// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once
#include <memory>
#include <napi.h>
#include <stdexcept>

#include "utils/map-set.h"
#include "utils/napi-helper.h"
#include "utils/pointer.h"
#include "utils/type-name.h"

#define CORE_OBJECT_FEAT_STRICT_EQ 0
#if defined(CORE_OBJECT_FEAT_STRICT_EQ) && CORE_OBJECT_FEAT_STRICT_EQ
#define FEAT_STRICT_EQ(...) __VA_ARGS__
#else
#define FEAT_STRICT_EQ(...)
#endif

template <SmartPtrLike P>
Napi::Value CreateObject(Napi::Env, const P &) noexcept;

template <SmartPtrLike P>
Napi::Value CreateObject(Napi::Value, const P &) noexcept;

#define CORE_OBJECT(CORE, OBJECT)                                              \
  template <>                                                                  \
  Napi::Value CreateObject<CORE>(Napi::Env env, const CORE &core) noexcept {   \
    return OBJECT::Create(env, core);                                          \
  }                                                                            \
  template <>                                                                  \
  Napi::Value CreateObject<CORE>(Napi::Value value,                            \
                                 const CORE &core) noexcept {                  \
    return OBJECT::Create(value, core);                                        \
  }                                                                            \
  void export##OBJECT(Napi::Env env, Napi::Object &exports) {                  \
    OBJECT::Export(env, exports);                                              \
  }

#define CORE_OBJECT_EXPORT(OBJECT, ...)                                        \
  void export##OBJECT(Napi::Env, Napi::Object &);                              \
  VERBOSE("Calling export" #OBJECT "() @ %p", &export##OBJECT);                \
  export##OBJECT(__VA_ARGS__);

/**
 * CoreObject is an abstraction for JS objects that corresponds to a native
 * object (Core). CoreObjects can only be constructed from C++ side using
 * CoreObject::Create(). It expects exactly one argument of type External<Core>
 *
 * When creating multiple JS objects that corresponds to the same native
 * object, CoreObject::Create() will always return the same JS object - thus
 * ensuring strict equality (===) for the same native object.
 */
template <class Obj, SmartPtrLike Core>
class CoreObject : public Napi::ObjectWrap<Obj> {
protected:
  /** Context-aware local storage per Node Env */
  class Local {
  public:
    typedef std::shared_ptr<Local> Ptr;
    template <typename... Args> static inline Ptr create(Args &&...args) {
      return std::make_shared<Local>(std::forward<Args>(args)...);
    }
    Napi::FunctionReference constructor;
    FEAT_STRICT_EQ(Map<uintptr_t, Napi::Reference<Napi::Value>> instances);
    Local(Napi::Function &fn)
        : constructor(Napi::Persistent(fn)) FEAT_STRICT_EQ(, instances())

    {}
    ~Local() { constructor.Reset(); }
  };
  /** Packed by Napi::External and passed to object constructor */
  typedef struct Payload {
    typedef std::shared_ptr<Payload> Ptr;
    static inline Ptr extract(Napi::Value val) {
      return Ptr(&::extract<Payload>(val));
    }
    const Local::Ptr local;
    const Core core;
  } Payload;
  /** Local DB Per Env */
  static inline std::mutex local_mutex;
  static inline Map<napi_env, typename Local::Ptr> locals;
  // Retrieve or create local context
  static inline Local::Ptr getLocal(Napi::Env env) {
    std::scoped_lock lock(local_mutex);
    if (!locals.has(env)) {
      __init__(env);
      auto success = locals.has(env);
      if (!success)
        throw JS::Error(env,
                        "Cannot dynamically initialize " + type_name<Obj>());
    }
    return locals.get(env);
  }

private:
  static inline Napi::Value __init__(Napi::Env env) {
    if (!locals.has(env)) {
      VERBOSE("Initializing local context for %s", Obj::name.c_str());
      auto fn = Obj::Init(env);
      locals.set(env, Local::create(fn));
      env.AddCleanupHook(__deinit__, static_cast<napi_env>(env));
    }
    return locals.get(env)->constructor.Value();
  }

  static void __deinit__(napi_env env) {
    VERBOSE("De-initializing local context for %s", Obj::name.c_str());
    std::scoped_lock lock(local_mutex);
    locals.erase(env);
  }

public:
  // Place holder function for dynamic initialization during JS runtime.
  // local_mutex is locked by caller.
  static Napi::Function Init(Napi::Env env) {
    throw std::runtime_error("Init() not implemented by CoreObject subclass");
  }
  // Static initialization during module-load.
  static inline void Export(Napi::Env env, Napi::Object &exports) {
    std::scoped_lock lock(local_mutex);
    exports.Set(Obj::name, __init__(env));
  }

private:
  typedef CoreObject<Obj, Core> Self;
  static inline Napi::Value __create__(Napi::Env env, Local::Ptr &local,
                                       Payload *p) {
    auto ext = Napi::External<Payload>::New(env, p);
    auto obj = local->constructor.New({ext});
    FEAT_STRICT_EQ(local->instances.set(uintptr(p->core), obj));
    return obj;
  }

public:
#define TRY_REUSE(INSTANCES, KEY)                                              \
  if (INSTANCES.has(KEY)) {                                                    \
    auto &ref = INSTANCES.get(KEY);                                            \
    if (!ref.IsEmpty())                                                        \
      return ref.Value();                                                      \
    else                                                                       \
      INSTANCES.erase(KEY);                                                    \
  }

  static Napi::Value inline Create(Napi::Env env, Core &core) noexcept {
    JS_EXCEPT_RET(
        {
          auto local = getLocal(env);
          FEAT_STRICT_EQ(TRY_REUSE(local->instances, uintptr(core)));
          return __create__(env, local,
                            new Payload{.local = local, .core = core});
        },
        env.Undefined());
  }

  template <typename... Args>
  static Napi::Value inline Create(Napi::Env env, Args &&...args) noexcept {
    JS_EXCEPT_RET(
        {
          Core core(std::forward<Args>(args)...);
          auto local = getLocal(env);
          FEAT_STRICT_EQ(TRY_REUSE(local->instances, uintptr(core)));
          return __create__(
              env, local, new Payload{.local = local, .core = std::move(core)});
        },
        env.Undefined());
  }

  static Napi::Value inline Create(Napi::Value value, Core &core) noexcept {
    auto env = value.Env();
    auto obj = Unwrap(value);
    if (!obj)
      return Create(env, core);
    JS_EXCEPT_RET(
        {
          auto local = getLocal(env);
          FEAT_STRICT_EQ(TRY_REUSE(local->instances, uintptr(core)));
          return __create__(env, local,
                            new Payload{.local = local, .core = core});
        },
        env.Undefined());
  }

  template <typename... Args>
  static Napi::Value inline Create(Napi::Value value, Args &&...args) noexcept {
    auto env = value.Env();
    auto obj = Unwrap(value);
    if (!obj)
      return Create(env, std::forward<Args>(args)...);
    JS_EXCEPT_RET(
        {
          Core core(std::forward<Args>(args)...);
          auto local = getLocal(env);
          FEAT_STRICT_EQ(TRY_REUSE(local->instances, uintptr(core)));
          return __create__(
              env, local, new Payload{.local = local, .core = std::move(core)});
        },
        env.Undefined());
  }

  static Obj *Unwrap(const Napi::Value &value) {
    if (!value.IsObject())
      return nullptr;
    return Napi::ObjectWrap<Obj>::Unwrap(value.As<Napi::Object>());
  }

public:
  static inline const std::string name = type_name<Obj>();
  /** Override this method to provide custom description */
  static std::string describe(const CoreObject *) { return "..."; }
  static void construct(Obj *) {};
  static void destruct(Obj *) {};

  static inline std::string str(const Obj *obj) {
    try {
      return str(Obj::describe(obj));
    } catch (...) {
      return Obj::name + " [error in " + type_name<Obj>() + "::describe()]";
    }
  }

  static inline std::string str(std::string tag) {
    return Obj::name + " [" + tag + "]";
  }

#define CORE_OBJECT_DECL(SELF)                                                 \
public:                                                                        \
  GET(id) { return Napi::String::New(info.Env(), SELF::id()); }                \
  GET(tag) { return Napi::String::New(info.Env(), SELF::describe(this)); }     \
  FN(toString) { return Napi::String::New(info.Env(), SELF::str(this)); }      \
  FN(release) {                                                                \
    this->__release__();                                                       \
    return this->undefined();                                                  \
  }

#define CORE_OBJECT_REGISTER(CLS, ENV)                                         \
  InstanceWrap<CLS>::template InstanceMethod<&CLS::toString>("toString"),      \
      InstanceWrap<CLS>::template InstanceAccessor<&CLS::get_id, nullptr>(     \
          "id", napi_enumerable),                                              \
      InstanceWrap<CLS>::template InstanceAccessor<&CLS::get_tag, nullptr>(    \
          Napi::Symbol::WellKnown(ENV, "toStringTag"), napi_enumerable),       \
      InstanceWrap<CLS>::template InstanceMethod<&CLS::release>("release")

  Napi::Env const env;
  inline auto null() const { return env.Null(); }
  inline auto undefined() const { return env.Undefined(); }

private:
  mutable Payload::Ptr payload;
  void __assign__(const Napi::CallbackInfo &info) {
    if (info.Env() != env)
      throw JS::Error(env, "Mismatched Napi::Env");
    payload = Payload::extract(info[0]);
    FEAT_STRICT_EQ(auto ref = Napi::Weak(info.This());
                   payload->local->instances.set(address(), ref);)
    Obj::construct(static_cast<Obj *>(this));
    VERBOSE("Constructed: %s", str(static_cast<Obj *>(this)).c_str());
  }

protected:
  void __release__() {
    if (!payload)
      return;
    auto tag = str(static_cast<Obj *>(this));
    Obj::destruct(static_cast<Obj *>(this));
    FEAT_STRICT_EQ(payload->local->instances.erase(address()));
    payload.reset();
    VERBOSE("Destructed: %s", tag.c_str());
  };

public:
  inline constexpr std::string type() const { return type_name<Obj>(); }
  inline const uintptr_t address() const { return uintptr(core()); }
  inline const std::string id() const {
    std::stringstream ss;
    ss << "0x" << std::hex << address();
    return ss.str();
  }
  inline const Core &core() const {
    // Accessing core of a releaseed object will crash the program.
    // This is strictly forbidden, and is not recoverable by JS try-catch.
    if (payload == nullptr)
      throw JS::Error(env, type() + " object already releaseed");
    return payload->core;
  }
  CoreObject(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<Obj>(info), env(info.Env()) {
    __assign__(info);
  }
  ~CoreObject() { __release__(); }
};
