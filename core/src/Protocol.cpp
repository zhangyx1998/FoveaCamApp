// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include "Protocol/Protocol.h"
#include <cstddef>
#include <cstdint>
#include <cstring>

#include <napi.h>

#include <Aravis/Camera.h>
#include <Aravis/Frame.h>
#include <Aravis/Stream.h>
#include <COBS/RX.h>
#include <COBS/TX.h>
#include <Protocol/Packet.h>
#include <Threading/Guard.h>
#include <convert.h>
#include <pointer.h>
#include <stdexcept>

#include "Protocol/Version.h"
#include "js_native_api.h"
#include "js_native_api_types.h"
#include "napi-helper.h"
#include "utils/map-set.h"

using namespace Napi;

using SymbolRegistry = Isolated<Napi::Reference<Napi::Symbol>>;

static SymbolRegistry bufferAccessor;
static SymbolRegistry propNameAccessor;

inline std::string hexFormat(const void *data, size_t size) {
  std::stringstream ss;
  const uint8_t *ptr = static_cast<const uint8_t *>(data);
  for (size_t i = 0; i < size; i++) {
    if (i != 0)
      ss << " ";
    ss << std::hex << std::uppercase << std::setfill('0') << std::setw(2)
       << static_cast<unsigned>(ptr[i]);
  }
  return ss.str();
}

static bool access(SymbolRegistry &registry, Napi::Value &value) {
  auto env = value.Env();
  auto accessor = registry.get(env).Value();
  if (value.IsObject() && value.As<Napi::Object>().Has(accessor)) {
    value = value.As<Napi::Object>().Get(accessor);
    return true;
  } else {
    return false;
  }
}

using Protocol::Method;
using Protocol::Property;

static Napi::Value getBuffer(Napi::Value value) {
  auto env = value.Env();
  auto accessor = bufferAccessor.get(env).Value();
  std::ignore = access(bufferAccessor, value);
  return value;
}

static Property getProperty(Napi::Value value) {
  auto env = value.Env();
  if (!access(propNameAccessor, value))
    throw JS::TypeError(env, "Packet missing [[PropertyName]] attribute");
  if (!value.IsString())
    throw JS::TypeError(env, "Attribute [[PropertyName]] must be a string");
  return convert<Property>(value.As<Napi::String>().Utf8Value());
}

template <Property P, FN(cb)>
Function factory(Napi::Env env, std::string name,
                 void cfg(Napi::Function &) = nullptr) {
  auto fn = Function::New(env, cb, "Packet[" + name + "]");
  if (cfg)
    cfg(fn);
  // Inject [[PropertyName]] property
  {
    auto symbol = propNameAccessor.get(env).Value();
    fn.DefineProperty(PropertyDescriptor::Value(
        symbol, String::New(env, convert<std::string>(P))));
  }
  fn.Freeze();
  return fn;
}

static inline Napi::Object inject(const Napi::CallbackInfo &info,
                                  Napi::Value value, const void *data,
                                  size_t size) {
  auto env = value.Env();
  napi_value obj;
  if (value.IsObject() && !value.IsNull()) {
    obj = value.As<Napi::Object>();
  } else {
    napi_coerce_to_object(env, value, &obj);
  }
  auto ret = Napi::Object(env, obj);
  auto buffer = Napi::ArrayBuffer::New(ret.Env(), size);
  std::memcpy(buffer.Data(), data, size);
  {
    // Inject [[Buffer]] property
    auto symbol = bufferAccessor.get(env).Value();
    ret.DefineProperty(PropertyDescriptor::Value(symbol, buffer));
  }
  ret.Freeze();
  return ret;
}

template <typename S>
inline Napi::Object inject(const Napi::CallbackInfo &info, Napi::Value value,
                           const S &data) {
  return inject(info, value, &data, sizeof(S));
}

#define EXPECT_EXACTLY_ONE_ARGUMENT(NAME)                                      \
  auto env = info.Env();                                                       \
  if (info.Length() != 1)                                                      \
    JS_THROW(TypeError, NAME " expects exactly one argument",                  \
             env.Undefined());                                                 \
  auto &arg = info[0];

static FN(BooleanPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Boolean>");
  uint8_t boolean;
  if (isBufferLike(arg)) {
    bufferView(arg) >> boolean;
  } else {
    boolean = arg.ToBoolean().Value() ? 1 : 0;
  }
  return inject(info, Boolean::New(env, boolean), boolean);
}

static FN(StringPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<String>");
  std::string str;
  if (arg.IsString()) {
    str = arg.As<Napi::String>().Utf8Value();
  } else if (isBufferLike(arg)) {
    auto buffer = bufferView<char>(arg);
    str = std::string(buffer.data, buffer.size);
  } else {
    JS_THROW(TypeError, "Argument must be a string or buffer like",
             env.Undefined());
  }
  return inject(info, String::New(env, str), str.data(), str.size());
}

template <typename E> static FN(EnumPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Enum>");
  E opt_value;
  std::string opt_name;
  if (arg.IsString()) {
    opt_name = arg.As<Napi::String>().Utf8Value();
    opt_value = convert<E>(opt_name);
  } else if (isBufferLike(arg)) {
    bufferView(arg) >> opt_value;
    opt_name = convert<std::string>(opt_value);
  } else {
    JS_THROW(TypeError, "Argument must be a string or buffer like",
             env.Undefined());
  }
  return inject(info, String::New(env, opt_name), opt_value);
}

static FN(Uint16Packet) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Uint16>");
  uint16_t value;
  if (arg.IsNumber()) {
    auto v = arg.As<Napi::Number>().Uint32Value();
    JS_ASSERT(v <= 0xFFFF, RangeError, "Number out of range for uint16 value",
              env.Undefined());
    value = static_cast<uint16_t>(v);
  } else if (isBufferLike(arg)) {
    bufferView(arg) >> value;
  } else {
    JS_THROW(TypeError, "Argument must be a string or buffer like",
             env.Undefined());
  }
  return inject(info, Number::New(env, value), value);
}

template <typename T>
inline void propertyMap(Napi::Object const &obj, std::string key, T &val,
                        bool optional = true) {
  if (obj.Has(key)) {
    val = convert<T>(obj.Get(key));
  } else if (!optional) {
    throw JS::TypeError(obj.Env(), "Missing required property: " + key);
  }
}

namespace System {
static FN(VersionPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Version>");
  Packet::System::Version version;
  if (isBufferLike(arg)) {
    bufferView(arg) >> version;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      propertyMap(obj, "major", version.major, false);
      propertyMap(obj, "minor", version.minor, false);
      propertyMap(obj, "patch", version.patch, false);
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("major", Number::New(env, version.major));
  object.Set("minor", Number::New(env, version.minor));
  object.Set("patch", Number::New(env, version.patch));
  return inject(info, object, version);
}

static void VersionPacketStaticProps(Napi::Function &fn) {
  fn.Set("major", Number::New(fn.Env(), Protocol::Version::Major));
  fn.Set("minor", Number::New(fn.Env(), Protocol::Version::Minor));
  fn.Set("patch", Number::New(fn.Env(), Protocol::Version::Patch));
}

static Napi::Object Init(Napi::Env env) {
  auto obj = Napi::Object::New(env);
  obj.Set("Info",
          factory<Property::SYS_INFO, StringPacket>(env, "System::Info"));
  obj.Set("Version", factory<Property::SYS_VERSION, VersionPacket>(
                         env, "System::Version", VersionPacketStaticProps));
  obj.Set("Reset",
          factory<Property::SYS_RESET, EnumPacket<Packet::System::Reset::Type>>(
              env, "System::Reset"));
  obj.Set("Enable",
          factory<Property::SYS_ENABLE, BooleanPacket>(env, "System::Enable"));
  obj.Freeze();
  return obj;
};
}; // namespace System

namespace Config {
static Napi::Object Init(Napi::Env env) {
  auto obj = Napi::Object::New(env);
  obj.Set("Log",
          factory<Property::CFG_LOG, EnumPacket<Packet::Config::Log::Level>>(
              env, "Config::Log"));
  obj.Set("LPF", factory<Property::CFG_LPF, Uint16Packet>(env, "Config::LPF"));
  obj.Set("Bias",
          factory<Property::CFG_BIAS, Uint16Packet>(env, "Config::Bias"));
  obj.Freeze();
  return obj;
};
}; // namespace Config

namespace Command {

inline void assignMirrorPosition(Napi::Value const &val,
                                 Packet::Command::MirrorPosition &pos) {
  if (isBufferLike(val))
    bufferView(val) >> pos;
  else if (val.IsArray() && val.As<Napi::Array>().Length() <= 4) {
    const auto &arr = val.As<Napi::Array>();
    for (unsigned i = 0; i < 4; i++) {
      auto v = arr.Get(i);
      pos.ch[i] = convert<uint16_t>(v);
    }
  } else {
    throw JS::TypeError(
        val.Env(),
        "MirrorPosition must be an array of integers or buffer like");
  }
}

static FN(ActuatePacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Actuate>");
  Packet::Command::Actuate command;
  if (isBufferLike(arg)) {
    bufferView(arg) >> command;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      assignMirrorPosition(obj.Get("left"), command.left);
      assignMirrorPosition(obj.Get("right"), command.right);
      if (obj.Has("settle_time"))
        command.settle_time =
            convert<Packet::Command::Microseconds>(obj.Get("settle_time"));
      if (obj.Has("complete_time"))
        command.complete_time =
            convert<Packet::Command::Microseconds>(obj.Get("complete_time"));
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  auto left = Napi::Array::New(env, 4);
  auto right = Napi::Array::New(env, 4);
  for (unsigned i = 0; i < 4; i++) {
    left.Set(i, Number::New(env, command.left.ch[i]));
    right.Set(i, Number::New(env, command.right.ch[i]));
  }
  object.Set("left", left);
  object.Set("right", right);
  object.Set("settle_time", Number::New(env, command.settle_time));
  object.Set("complete_time", Number::New(env, command.complete_time));
  return inject(info, object, command);
}

static Napi::Object Init(Napi::Env env) {
  auto obj = Napi::Object::New(env);
  obj.Set("Actuate", factory<Property::CMD_ACTUATE, ActuatePacket>(
                         env, "Command::Actuate"));
  obj.Set("Trigger", factory<Property::CMD_TRIGGER, Uint16Packet>(
                         env, "Command::Trigger"));
  obj.Freeze();
  return obj;
};

}; // namespace Command

class PendingRequest : public Unique<PendingRequest> {
private:
  bool resolved = false;
  Napi::Promise::Deferred deferred;

public:
  const Napi::Env env;
  const struct {
    Method method;
    Property property;
    inline bool match(Method m, Property p) const {
      return method == m && property == p;
    }
  } expect;
  PendingRequest(Napi::Env env, Method method, Property property)
      : env(env), expect{method, property},
        deferred(Napi::Promise::Deferred::New(env)) {}
  ~PendingRequest() {
    if (!resolved)
      try {
        Reject(Napi::Error::New(env, "Request timeout").Value());
      } catch (...) {
        // Allow silently fail during module cleanup
      }
  }
  inline void Resolve(Napi::Value value) {
    resolved = true;
    deferred.Resolve(value);
  }
  inline void Reject(Napi::Value reason) {
    resolved = true;
    deferred.Reject(reason);
  }
  inline Napi::Promise Promise() { return deferred.Promise(); }
};

class ProtocolObject : public ObjectWrap<ProtocolObject> {
public:
  static Function Init(Napi::Env env) {
    bufferAccessor.get(env) =
        Napi::Persistent(Napi::Symbol::New(env, "Buffer"));
    propNameAccessor.get(env) =
        Napi::Persistent(Napi::Symbol::New(env, "PropertyName"));
    auto fn = DefineClass(env, "Protocol",
                          {
                              INSTANCE_METHOD(ProtocolObject, __rx__),   //
                              INSTANCE_ACCESSOR(ProtocolObject, __tx__), //
                              INSTANCE_METHOD(ProtocolObject, get),      //
                              INSTANCE_METHOD(ProtocolObject, set),      //
                          });
    return fn;
  }

  ProtocolObject(const CallbackInfo &info)
      : ObjectWrap<ProtocolObject>(info), env(info.Env()), tx(), rx() {
    VERBOSE("ProtocolObject::construct @ %p", this);
  }

  ~ProtocolObject() {
    VERBOSE("ProtocolObject::destruct @ %p", this);
    if (!__tx__.IsEmpty()) {
      __tx__.Reset();
    }
    // PR Destructor automatically rejects pending promises
    pending.clear();
  }

private:
  const Napi::Env env;
  COBS::TX tx;
  COBS::RX rx;
  Napi::FunctionReference __tx__;
  Map<uint16_t, PendingRequest::Ptr> pending;
  uint16_t __sequence__ = 0;
  inline uint16_t sequence() {
    if (__sequence__ == 0)
      __sequence__ = 1;
    return __sequence__++;
  }

  GET(__tx__) {
    if (__tx__.IsEmpty())
      return env.Null();
    return __tx__.Value();
  }

  SET(__tx__) {
    if (val.IsNull() || val.IsUndefined()) {
      __tx__.Reset();
      return;
    }
    JS_ASSERT(val.IsFunction(), TypeError,
              "__tx__ must be a function or null", );
    __tx__ = Napi::Persistent(val.As<Napi::Function>());
  }

  FN(__rx__) {
    if (info.Length() != 1)
      JS_THROW(TypeError, "Invalid argument, expected array buffer like",
               env.Undefined());
    auto &value = info[0];
    if (!isBufferLike(value))
      JS_THROW(TypeError, "Invalid argument, expected array buffer like",
               env.Undefined());
    const auto buffer = bufferView(value);
    VERBOSE("Protocol::recv() prev %u bytes + incoming %zu bytes", rx.len(),
            buffer.size);
    for (auto &byte : buffer) {
      if (!rx.recv(byte))
        continue;
      Protocol::RawPacket packet(rx.get());
      auto header = packet.validate();
      try {
        if (header == Protocol::INVALID)
          throw std::invalid_argument("Corrupted packet");
        const auto method = Protocol::method(header);
        const auto property = Protocol::property(header);
        const auto &sequence = packet.header().sequence;
        auto payload = ArrayBuffer::New(env, packet.dataSize());
        std::memcpy(payload.Data(), packet.data(), packet.dataSize());
        VERBOSE("Protocol::recv %s:%s (seq=%u) payload %zu bytes",
                convert<std::string>(method).c_str(),
                convert<std::string>(property).c_str(), sequence,
                packet.dataSize());
        if (pending.has(sequence)) {
          if (pending[sequence]->expect.match(method, property)) {
            pending[sequence]->Resolve(payload);
          } else if (method == Method::REJ) {
            // REJ packets always have a string payload
            auto reason = std::string((char *)packet.data(), packet.dataSize());
            pending[sequence]->Reject(Napi::Error::New(env, reason).Value());
          } else {
            pending[sequence]->Reject(
                Napi::Error::New(env, "Unexpected response " +
                                          convert<std::string>(method) + ":" +
                                          convert<std::string>(property))
                    .Value());
          }
          pending.erase(sequence);
        } else if (method == Method::SYN && property == Property::LOG) {
          // Unsolicited log packet
          std::string log_msg((char *)packet.data(), packet.dataSize());
          std::cout << "[Protocol] Device log: " << log_msg << std::endl;
        } else {
          std::cerr << "[Protocol] [WARN] Unmatched packet "
                    << convert<std::string>(method) << ":"
                    << convert<std::string>(property) << " (seq=" << sequence
                    << ")" << hexFormat(packet.data(), packet.dataSize())
                    << std::endl;
        }
      } catch (std::invalid_argument &e) {
        std::cerr << "[Protocol] [WARN] Bad rx data: " << e.what() << std::endl;
        continue;
      }
    }
    return env.Undefined();
  }

  Napi::Value send(uint16_t sequence, Property property,
                   const Napi::Function &factory, Protocol::RawPacket &packet) {
    try {
      if (tx.encode(packet.finalize())) {
        auto buffer = Napi::ArrayBuffer::New(env, tx.size());
        std::memcpy(buffer.Data(), tx.data(), tx.size());
        // Hand over
        if (__tx__.IsEmpty())
          JS_THROW(Error, "No __tx__ function defined", env.Null());
        auto fn = __tx__.Value();
        fn.Call({buffer});
        // Create promise
        auto pr = PendingRequest::create(env, Method::ACK, property);
        // Create return promise.then(callback)
        auto promise = pr->Promise().Then(factory);
        pending[sequence] = std::move(pr);
        return promise;
      } else {
        throw JS::Error(env, "Failed to encode packet");
      }
    }
    JS_EXCEPT(env.Null())
  }

  FN(get) {
    EXPECT_EXACTLY_ONE_ARGUMENT("Protocol::get");
    const auto &factory = arg.As<Napi::Function>();
    const auto property = getProperty(factory);
    const auto sequence = this->sequence();
    Protocol::RawPacket packet(Method::GET, property, sequence);
    return send(sequence, property, factory, packet);
  }
  FN(set) {
    auto env = info.Env();
    if (info.Length() < 1)
      JS_THROW(TypeError, "Protocol::set expects at least one argument",
               env.Undefined());
    const auto &factory = info[0].As<Napi::Function>();
    const auto property = getProperty(factory);
    const auto sequence = this->sequence();
    Protocol::RawPacket packet(Method::SET, property, sequence);
    if (info.Length() > 1) {
      auto buffer = getBuffer(factory.Call({info[1]}));
      if (!isBufferLike(buffer))
        JS_THROW(TypeError,
                 "Packet factory must return an array buffer like object",
                 env.Undefined());
      packet.setData(bufferView(buffer));
    }
    return send(sequence, property, factory, packet);
  }
};

void exportProtocolObject(Napi::Env env, Napi::Object &exports) {
  auto Protocol = ProtocolObject::Init(env);
  Protocol.Set("Log", factory<Property::LOG, StringPacket>(env, "Log"));
  Protocol.Set("System", System::Init(env));
  Protocol.Set("Config", Config::Init(env));
  Protocol.Set("Command", Command::Init(env));
  Protocol.Freeze();
  exports.Set("Protocol", Protocol);
}
