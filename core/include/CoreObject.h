// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once
#include <napi.h>
#include <stdexcept>

#include <Threading/Guard.h>
#include <convert.h>
#include <pointer.h>
#include <type_name.h>
#include <utils/map-set.h>

#include "Cleanup.h"
#include "napi-helper.h"

// TODO: Strict equality for CoreObjects pointing to the same native object
#define CORE_OBJECT_FEAT_STRICT_EQ 0
#if defined(CORE_OBJECT_FEAT_STRICT_EQ) && CORE_OBJECT_FEAT_STRICT_EQ
#define FEAT_STRICT_EQ(...) __VA_ARGS__
#else
#define FEAT_STRICT_EQ(...)
#endif

#define CORE_OBJECT_CONVERSIONS(OBJECT)                                        \
  /* Conversion from CoreObject pointer to JS object */                        \
  template <>                                                                  \
  Napi::Value convert(Napi::Env env, const OBJECT::Core &core) noexcept {      \
    return OBJECT::Create(env, core);                                          \
  }                                                                            \
  template <>                                                                  \
  Napi::Value convert(Napi::Env env, const Napi::Value &container,             \
                      const OBJECT::Core &core) noexcept {                     \
    return OBJECT::Create(container, core);                                    \
  }                                                                            \
  /* Conversion from JS object to CoreObject pointer */                        \
  template <> OBJECT::Core convert(const Napi::Value &value) {                 \
    if (!value.IsObject())                                                     \
      throw JS::TypeError(value.Env(), "Argument must be an object");          \
    auto obj = value.As<Napi::Object>();                                       \
    auto wrapped = Napi::ObjectWrap<OBJECT>::Unwrap(obj);                      \
    if (!wrapped)                                                              \
      throw JS::TypeError(value.Env(),                                         \
                          "Argument is not instance of " + OBJECT::name);      \
    return wrapped->core();                                                    \
  }

#define CORE_OBJECT(OBJECT)                                                    \
  /* Export CoreObject constructor to exports */                               \
  void export##OBJECT(Napi::Env env, Napi::Object &exports) {                  \
    OBJECT::Export(env, exports);                                              \
  }                                                                            \
  CORE_OBJECT_CONVERSIONS(OBJECT)

#define CORE_OBJECT_EXPORT(OBJECT, ...)                                        \
  {                                                                            \
    void export##OBJECT(Napi::Env, Napi::Object &);                            \
    VERBOSE_TIMER("export " #OBJECT);                                          \
    VERBOSE("Calling export" #OBJECT "() @ %p", &export##OBJECT);              \
    export##OBJECT(__VA_ARGS__);                                               \
  }

/**
 * CoreObject is an abstraction for JS objects that corresponds to a native
 * object (Core). CoreObjects can only be constructed from C++ side using
 * CoreObject::Create(). It expects exactly one argument of type External<Core>
 *
 * When creating multiple JS objects that corresponds to the same native
 * object, CoreObject::Create() will always return the same JS object - thus
 * ensuring strict equality (===) for the same native object.
 */
template <class Obj, SmartPtrLike _Core>
class CoreObject : public Napi::ObjectWrap<Obj> {
public:
  using Core = _Core;

protected:
  /** Context-aware local storage per Node Env */
  class Local : public Shared<Local> {
  public:
    Napi::FunctionReference constructor;
    FEAT_STRICT_EQ(Map<uintptr_t, Napi::Reference<Napi::Value>> instances);
    Local(Napi::Function &fn)
        : constructor(Napi::Persistent(fn)) FEAT_STRICT_EQ(, instances()) {}
    ~Local() { constructor.Reset(); }
  };
  /** Packed by Napi::External and passed to object constructor */
  typedef struct Payload : public Shared<Payload> {
    const Local::Ptr local;
    const Core core;
  } Payload;
  /** Local DB Per Env */
  typedef Map<napi_env, typename Local::Ptr> Locals;
  typedef Threading::Guard<Locals> LocalsGuard;
  static inline LocalsGuard locals;
  // Retrieve or create local context
  static inline Local::Ptr getLocal(Napi::Env env) {
    auto ref = locals.ref();
    if (!ref->has(env)) {
      CoreObjectInit(env, ref);
      auto success = ref->has(env);
      if (!success)
        throw JS::Error(env,
                        "Cannot dynamically initialize " + type_name<Obj>());
    }
    return ref->get(env);
  }

private:
  static inline Napi::Value CoreObjectInit(Napi::Env env,
                                           LocalsGuard::Ref &ref) {
    if (!ref->has(env)) {
      VERBOSE("Initializing local context for %s", Obj::name.c_str());
      auto fn = Obj::Init(env);
      ref->set(env, Local::create(fn));
      Cleanup::add(env, static_cast<napi_env>(env),
                   &CoreObject::CoreObjectDeinit, "Context[" + Obj::name + "]");
    }
    return ref->get(env)->constructor.Value();
  }

  static void CoreObjectDeinit(napi_env env) {
    VERBOSE("De-initializing local context for %s", Obj::name.c_str());
    locals.ref()->erase(env);
  }

public:
  // Place holder function for dynamic initialization during JS runtime.
  static Napi::Function Init(Napi::Env env) {
    throw std::runtime_error("Init() not implemented by CoreObject subclass");
  }
  // Static initialization during module-load.
  static inline void Export(Napi::Env env, Napi::Object &exports) {
    auto ref = locals.ref();
    exports.Set(Obj::name, CoreObjectInit(env, ref));
  }

private:
  typedef CoreObject<Obj, Core> Self;
  static inline Napi::Value CoreObjectCreate(Napi::Env env, Local::Ptr &local,
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
    try {
      auto local = getLocal(env);
      FEAT_STRICT_EQ(TRY_REUSE(local->instances, uintptr(core)));
      return CoreObjectCreate(env, local,
                              new Payload{.local = local, .core = core});
    }
    JS_EXCEPT(env.Undefined())
  }

  template <typename... Args>
  static Napi::Value inline Create(Napi::Env env, Args &&...args) noexcept {
    try {
      Core core(std::forward<Args>(args)...);
      auto local = getLocal(env);
      FEAT_STRICT_EQ(TRY_REUSE(local->instances, uintptr(core)));
      return CoreObjectCreate(
          env, local, new Payload{.local = local, .core = std::move(core)});
    }
    JS_EXCEPT(env.Undefined())
  }

  static Napi::Value inline Create(Napi::Value value, Core &core) noexcept {
    auto env = value.Env();
    auto obj = Unwrap(value);
    if (!obj)
      return Create(env, core);
    try {
      auto local = getLocal(env);
      FEAT_STRICT_EQ(TRY_REUSE(local->instances, uintptr(core)));
      return CoreObjectCreate(env, local,
                              new Payload{.local = local, .core = core});
    }
    JS_EXCEPT(env.Undefined())
  }

  template <typename... Args>
  static Napi::Value inline Create(Napi::Value value, Args &&...args) noexcept {
    auto env = value.Env();
    auto obj = Unwrap(value);
    if (!obj)
      return Create(env, std::forward<Args>(args)...);
    try {
      Core core(std::forward<Args>(args)...);
      auto local = getLocal(env);
      FEAT_STRICT_EQ(TRY_REUSE(local->instances, uintptr(core)));
      return CoreObjectCreate(
          env, local, new Payload{.local = local, .core = std::move(core)});
    }
    JS_EXCEPT(env.Undefined())
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
  static void construct(const Napi::CallbackInfo &, Obj *) {};
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
  FN(ref) {                                                                    \
    const auto env = info.Env();                                               \
    try {                                                                      \
      return SELF::Create(env, this->core());                                  \
    }                                                                          \
    JS_EXCEPT(env.Undefined())                                                 \
  }                                                                            \
  FN(release) {                                                                \
    this->releaseCoreObject();                                                 \
    Cleanup::remove(info.Env(), this);                                         \
    return this->undefined();                                                  \
  }

#define CORE_OBJECT_REGISTER(CLS, ENV)                                         \
  Napi::InstanceWrap<CLS>::template InstanceMethod<&CLS::toString>(            \
      "toString"),                                                             \
      Napi::InstanceWrap<CLS>::template InstanceAccessor<&CLS::get_id,         \
                                                         nullptr>(             \
          "id", napi_enumerable),                                              \
      Napi::InstanceWrap<CLS>::template InstanceAccessor<&CLS::get_tag,        \
                                                         nullptr>(             \
          Napi::Symbol::WellKnown(ENV, "toStringTag"), napi_enumerable),       \
      Napi::InstanceWrap<CLS>::template InstanceMethod<&CLS::ref>("ref"),      \
      Napi::InstanceWrap<CLS>::template InstanceMethod<&CLS::release>(         \
          "release")

  Napi::Env const env;
  inline auto null() const { return env.Null(); }
  inline auto undefined() const { return env.Undefined(); }

private:
  mutable Payload::Ptr payload;

protected:
  Napi::Env::CleanupHook<std::function<void(napi_env)>> cleanup;
  void releaseCoreObject() {
    if (!payload)
      return;
    auto tag = str(static_cast<Obj *>(this));
    Obj::destruct(static_cast<Obj *>(this));
    FEAT_STRICT_EQ(payload->local->instances.erase(address()));
    payload.reset();
    VERBOSE("Released: %s", tag.c_str());
  };
  static void CleanupThunk(Self *self) {
    if (self)
      self->releaseCoreObject();
  }

public:
  inline constexpr std::string type() const { return type_name<Obj>(); }
  inline const uintptr_t address() const { return uintptr(core()); }
  inline const std::string id() const {
    std::stringstream ss;
    ss << "0x" << std::hex << address();
    return ss.str();
  }
  inline Core const &core() const {
    // Accessing core of a released object will crash the program.
    // This is strictly forbidden, and is not recoverable by JS try-catch.
    if (payload == nullptr)
      throw JS::Error(env, type() + " object already released");
    return payload->core;
  }
  static inline Core ConstructFromJS(const Napi::CallbackInfo &info) {
    throw JS::TypeError(info.Env(),
                        "Cannot construct " + Obj::name + " from JS");
  };
  CoreObject(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<Obj>(info), env(info.Env()) {
    VERBOSE("Constructing %s", Obj::name.c_str());
    Cleanup::add(env, this, &Self::CleanupThunk, Obj::name);
    if (info[0].IsExternal()) {
      try {
        payload = typename Payload::Ptr(&::extract<Payload>(info[0]));
      }
      JS_EXCEPT()
    } else {
      try {
        payload = typename Payload::Ptr(new Payload{
            .local = getLocal(env),
            .core = Obj::ConstructFromJS(info),
        });
      }
      JS_EXCEPT()
    }
    FEAT_STRICT_EQ(auto ref = Napi::Weak(info.This());
                   payload->local->instances.set(address(), ref);)
    try {
      Obj::construct(info, static_cast<Obj *>(this));
    }
    JS_EXCEPT()
    VERBOSE("Constructed %s", str(static_cast<Obj *>(this)).c_str());
  }
  ~CoreObject() {
    Cleanup::remove(env, this);
    releaseCoreObject();
    VERBOSE("Destructed: %s", str(static_cast<Obj *>(this)).c_str());
  }
};
