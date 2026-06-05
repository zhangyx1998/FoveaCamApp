// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstddef>
#include <cstdint>
#include <cstring>

#include <napi.h>
#include <stdexcept>
#include <sys/fcntl.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

#include <Aravis/Camera.h>
#include <Aravis/Frame.h>
#include <Aravis/Stream.h>
#include <COBS/RX.h>
#include <COBS/TX.h>
#include <Protocol/Packet.h>
#include <Threading/Guard.h>
#include <convert.h>
#include <pointer.h>

#include "Cleanup.h"
#include "Dispatcher.h"
#include "Protocol/Protocol.h"
#include "Protocol/Version.h"
#include "napi-helper.h"
#include "utils/debug.h"

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
  Packet::Command::Actuate command = {.settle_time = 0};
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

class PendingRequest : public Shared<PendingRequest> {
public:
  const Napi::Env env;

private:
  bool resolved = false;
  Dispatcher::Future future = {env};

public:
  Napi::Reference<Napi::Function> factory;
  const struct {
    Method method;
    Property property;
    inline bool match(Method m, Property p) const {
      return method == m && property == p;
    }
  } expect;
  PendingRequest(Napi::Env env, Method method, Property property)
      : env(env), expect{method, property} {}
  PendingRequest(Napi::Env env, Method method, Property property,
                 Napi::Function fn)
      : env(env), expect{method, property}, factory(Napi::Persistent(fn)) {}
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
    future.Resolve(factory.IsEmpty() ? value : factory.Value().Call({value}));
  }
  inline void Reject(Napi::Value reason) {
    resolved = true;
    future.Reject(reason);
  }
  inline Napi::Promise Promise() { return future.Promise(); }
};

extern int SerialOpen(const Napi::CallbackInfo &info) noexcept;

class DeviceObject : public ObjectWrap<DeviceObject> {
public:
  static Function Init(Napi::Env env) {
    return DefineClass(env, "Protocol",
                       {
                           INSTANCE_GETTER(DeviceObject, connected), //
                           INSTANCE_METHOD(DeviceObject, get),       //
                           INSTANCE_METHOD(DeviceObject, set),       //
                           INSTANCE_METHOD(DeviceObject, release),   //
                       });
  }

  DeviceObject(const CallbackInfo &info)
      : ObjectWrap<DeviceObject>(info), env(info.Env()), fd(SerialOpen(info)),
        tx(), rx(), rx_thread(&DeviceObject::rxLoop, this) {}

  ~DeviceObject() {
    Cleanup::remove(env, cleanup_hook);
    destroy();
  }

  void destroy() noexcept {
    if (flag_term)
      return;
    if (fd >= 0) {
      // Write disable command
      Protocol::RawPacket packet(Method::SET, Property::SYS_ENABLE, 0);
      uint8_t enable = 0;
      packet.setData(&enable, sizeof(enable));
      tx.encode(packet.finalize());
      ::write(fd, tx.data(), tx.size());
      // Wait a moment for the device to respond
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    flag_term = true;
    if (rx_thread.joinable())
      rx_thread.join();
    if (fd >= 0) {
      // Release exclusive access before closing (macOS/BSD)
#ifdef TIOCNXCL
      ioctl(fd, TIOCNXCL);
#endif
      ::close(fd);
    }
  }

private:
  const Napi::Env env;
  Cleanup::UID cleanup_hook =
      Cleanup::add(env, [this] { this->destroy(); }, "DeviceObject");
  bool flag_term = false;
  const int fd;
  COBS::TX tx;
  COBS::RX rx;
  Threading::Guard<Map<uint16_t, PendingRequest::Ptr>> pending;
  std::thread rx_thread;
  // Napi::FunctionReference __tx__;
  uint16_t __sequence__ = 0;
  inline uint16_t sequence() {
    if (__sequence__ == 0)
      __sequence__ = 1;
    return __sequence__++;
  }

  GET(connected) { return Napi::Boolean::New(env, !flag_term); }

  inline void handleRawPacket(Protocol::RawPacket &&packet) noexcept {
    try {
      auto header = packet.validate();
      if (header == Protocol::INVALID)
        throw std::invalid_argument("Corrupted packet");
      const auto method = Protocol::method(header);
      const auto property = Protocol::property(header);
      const auto &sequence = packet.header().sequence;
      VERBOSE("recv %s:%s (seq=%u) payload %zu bytes",
              convert<std::string>(method).c_str(),
              convert<std::string>(property).c_str(), sequence,
              packet.dataSize());
      auto p = pending.ref();
      if (p->has(sequence)) {
        Dispatcher::dispatch(env, [pr = std::move(p->at(sequence)), method,
                                   property,
                                   packet = std::move(packet)](napi_env env) {
          auto payload = ArrayBuffer::New(env, packet.dataSize());
          std::memcpy(payload.Data(), packet.data(), packet.dataSize());
          if (pr->expect.match(method, property)) {
            pr->Resolve(payload);
          } else if (method == Method::REJ) {
            // REJ packets always have a string payload
            auto reason =
                std::string((char *)payload.Data(), payload.ByteLength());
            pr->Reject(Napi::Error::New(pr->env, reason).Value());
          } else {
            pr->Reject(Napi::Error::New(pr->env,
                                        "Unexpected response " +
                                            convert<std::string>(method) + ":" +
                                            convert<std::string>(property))
                           .Value());
          }
        });
        p->erase(sequence);
      } else if (method == Method::SYN && property == Property::LOG) {
        // Unsolicited log packet
        std::string log_msg((char *)packet.data(), packet.dataSize());
        __LOG__("%s", "PORT ", GREEN, "Device", log_msg.c_str());
      } else if (sequence != 0) {
        WARN("Unmatched packet %s:%s (seq=%u) %s",
             convert<std::string>(method).c_str(),
             convert<std::string>(property).c_str(), sequence,
             hexFormat(packet.data(), packet.dataSize()).c_str());
      }
    } catch (std::invalid_argument &e) {
      WARN("Bad rx data: %s", e.what());
    }
  }

  void rxLoop() {
    VERBOSE("Device::rxLoop started for fd %d", fd);
    char byte;
    ssize_t count;
    while (!flag_term) {
      auto count = ::read(fd, &byte, 1);
      if (count < 0) {
        ERROR("Failed to read from serial port: %s", std::strerror(errno));
        continue;
      } else if (count == 0) {
        std::this_thread::yield();
        continue;
      }
      VERBOSE("Device::recv() %u bytes + incoming 0x%s", rx.len(),
              hexFormat(&byte, 1).c_str());
      if (rx.recv(byte))
        handleRawPacket(Protocol::RawPacket(rx.get()));
    }
  }

  Napi::Value send(uint16_t sequence, Property property,
                   const Napi::Function &factory, Protocol::RawPacket &packet) {
    try {
      if (tx.encode(packet.finalize())) {
        VERBOSE("send %u bytes: %s", tx.size(),
                hexFormat(tx.data(), tx.size()).c_str());
        // Write buffer to serial fd
        auto written = ::write(fd, tx.data(), tx.size());
        VERBOSE("wrote %zd bytes to fd %d", written, fd);
        if (written < 0)
          JS_THROW(Error,
                   "Failed to write to serial port: " +
                       std::string(std::strerror(errno)),
                   env.Undefined());
        if (written != static_cast<ssize_t>(tx.size()))
          JS_THROW(Error, "Incomplete write to serial port", env.Undefined());
        // Create promise
        auto pr = PendingRequest::create(env, Method::ACK, property, factory);
        pending.ref()->set(sequence, pr);
        return pr->Promise();
      } else {
        throw JS::Error(env, "Failed to encode packet");
      }
    }
    JS_EXCEPT(env.Null())
  }

  FN(get) {
    EXPECT_EXACTLY_ONE_ARGUMENT("Device::get");
    const auto &factory = arg.As<Napi::Function>();
    const auto property = getProperty(factory);
    const auto sequence = this->sequence();
    Protocol::RawPacket packet(Method::GET, property, sequence);
    return send(sequence, property, factory, packet);
  }

  FN(set) {
    auto env = info.Env();
    if (info.Length() < 1)
      JS_THROW(TypeError, "Device::set expects at least one argument",
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

  FN(release) {
    destroy();
    return env.Undefined();
  }
};

void exportControllerModule(Napi::Env env, Napi::Object &exports) {
  bufferAccessor.get(env) = Napi::Persistent(Napi::Symbol::New(env, "Buffer"));
  propNameAccessor.get(env) =
      Napi::Persistent(Napi::Symbol::New(env, "PropertyName"));
  exports.Set("Device", DeviceObject::Init(env));
  auto Protocol = Napi::Object::New(env);
  Protocol.Set("Log", factory<Property::LOG, StringPacket>(env, "Log"));
  Protocol.Set("System", System::Init(env));
  Protocol.Set("Config", Config::Init(env));
  Protocol.Set("Command", Command::Init(env));
  Protocol.Freeze();
  exports.Set("Protocol", Protocol);
}
