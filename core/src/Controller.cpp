// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <algorithm>
#include <atomic>
#include <optional>

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
// Cached decoders for CMD_FRAME's asymmetric ACK/FIN payloads (FrameAccepted
// / FrameResult), set once in Command::Init and used by DeviceObject::send
// to override the request-encoder factory when decoding responses — see
// docs/refactor/synced-capture.md §5/§9 (P3).
static Isolated<Napi::Reference<Napi::Function>> frameAcceptedFactory;
static Isolated<Napi::Reference<Napi::Function>> frameResultFactory;

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

inline std::string hexPreview(const void *data, size_t size,
                              size_t limit = 8) {
  return hexFormat(data, std::min(size, limit));
}

template <typename PendingMap>
inline std::string pendingSequences(const PendingMap &pending) {
  std::stringstream ss;
  ss << "[";
  bool first = true;
  for (const auto &[seq, _] : pending) {
    if (!first)
      ss << ",";
    first = false;
    ss << seq;
  }
  ss << "]";
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

inline Napi::Array mirrorPositionToArray(
    Napi::Env env, const Packet::Command::MirrorPosition &pos) {
  auto arr = Napi::Array::New(env, 4);
  for (unsigned i = 0; i < 4; i++)
    arr.Set(i, Number::New(env, pos.ch[i]));
  return arr;
}

// CameraMask <-> JS: a number (raw bitmask) or an array of camera-name
// strings ("C"/"L"/"R"); undefined/omitted means "firmware default"
// (CAM_L | CAM_R — C is REJected until it has a strobe cable, see
// docs/refactor/synced-capture.md §2/§8).
inline uint8_t parseCameraMask(Napi::Value const &val) {
  if (val.IsUndefined() || val.IsNull())
    return 0;
  if (val.IsNumber())
    return convert<uint8_t>(val);
  if (val.IsArray()) {
    uint8_t mask = 0;
    const auto &arr = val.As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length(); i++) {
      auto name = arr.Get(i).ToString().Utf8Value();
      if (name == "C")
        mask |= Packet::Command::CAM_C;
      else if (name == "L")
        mask |= Packet::Command::CAM_L;
      else if (name == "R")
        mask |= Packet::Command::CAM_R;
      else
        throw JS::TypeError(val.Env(), "Unknown camera name: " + name);
    }
    return mask;
  }
  throw JS::TypeError(val.Env(),
                      "cameras must be a number or array of camera names");
}

inline Napi::Array cameraMaskToArray(Napi::Env env, uint8_t mask) {
  auto arr = Napi::Array::New(env);
  uint32_t i = 0;
  if (mask & Packet::Command::CAM_C)
    arr.Set(i++, String::New(env, "C"));
  if (mask & Packet::Command::CAM_L)
    arr.Set(i++, String::New(env, "L"));
  if (mask & Packet::Command::CAM_R)
    arr.Set(i++, String::New(env, "R"));
  return arr;
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
  object.Set("left", mirrorPositionToArray(env, command.left));
  object.Set("right", mirrorPositionToArray(env, command.right));
  object.Set("settle_time", Number::New(env, command.settle_time));
  object.Set("complete_time", Number::New(env, command.complete_time));
  return inject(info, object, command);
}

// CMD_STREAM: create/update/terminate a named mirror-position target.
// Single-phase (ACK echoes the same shape back, no FIN — see §3.2/§9).
static FN(MirrorStreamPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<MirrorStream>");
  Packet::Command::MirrorStream command{};
  if (isBufferLike(arg)) {
    bufferView(arg) >> command;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      std::string op_name;
      propertyMap(obj, "op", op_name, false);
      command.op = convert<Packet::Command::MirrorStream::Op>(op_name);
      propertyMap(obj, "id", command.id, false);
      if (obj.Has("left"))
        assignMirrorPosition(obj.Get("left"), command.left);
      if (obj.Has("right"))
        assignMirrorPosition(obj.Get("right"), command.right);
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("op", String::New(env, convert<std::string>(command.op)));
  object.Set("id", Number::New(env, command.id));
  object.Set("left", mirrorPositionToArray(env, command.left));
  object.Set("right", mirrorPositionToArray(env, command.right));
  return inject(info, object, command);
}

// CMD_FRAME GET request payload (stream/cameras/pulse). Two-phase: ACK
// carries FrameAccepted, FIN carries FrameResult (both decoded via their own
// factories below, NOT this one — see DeviceObject::send).
static FN(FramePacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Frame>");
  Packet::Command::Frame command{};
  if (isBufferLike(arg)) {
    bufferView(arg) >> command;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      propertyMap(obj, "stream", command.stream, false);
      command.cameras =
          obj.Has("cameras") ? parseCameraMask(obj.Get("cameras")) : 0;
      command.pulse =
          obj.Has("pulse")
              ? convert<Packet::Command::Microseconds>(obj.Get("pulse"))
              : 0;
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("stream", Number::New(env, command.stream));
  object.Set("cameras", cameraMaskToArray(env, command.cameras));
  object.Set("pulse", Number::New(env, command.pulse));
  return inject(info, object, command);
}

// CMD_FRAME ACK payload: queue position (0 = about to start now).
static FN(FrameAcceptedPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<FrameAccepted>");
  Packet::Command::FrameAccepted result{};
  if (isBufferLike(arg)) {
    bufferView(arg) >> result;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      propertyMap(obj, "queue_position", result.queue_position, false);
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("queue_position", Number::New(env, result.queue_position));
  return inject(info, object, result);
}

// CMD_FRAME FIN payload: latched at exposure start. Timestamps are BigInt
// (uint64 µs, matching Global::time on the firmware side — see §9 FW1).
static FN(FrameResultPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<FrameResult>");
  Packet::Command::FrameResult result{};
  if (isBufferLike(arg)) {
    bufferView(arg) >> result;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      propertyMap(obj, "stream", result.stream, false);
      if (obj.Has("t_trigger"))
        result.t_trigger =
            convert<Packet::Command::Timestamp>(obj.Get("t_trigger"));
      if (obj.Has("t_exposure"))
        result.t_exposure =
            convert<Packet::Command::Timestamp>(obj.Get("t_exposure"));
      if (obj.Has("left"))
        assignMirrorPosition(obj.Get("left"), result.left);
      if (obj.Has("right"))
        assignMirrorPosition(obj.Get("right"), result.right);
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("stream", Number::New(env, result.stream));
  object.Set("t_trigger", convert(env, result.t_trigger));
  object.Set("t_exposure", convert(env, result.t_exposure));
  object.Set("left", mirrorPositionToArray(env, result.left));
  object.Set("right", mirrorPositionToArray(env, result.right));
  return inject(info, object, result);
}

static Napi::Object Init(Napi::Env env) {
  auto obj = Napi::Object::New(env);
  obj.Set("Actuate", factory<Property::CMD_ACTUATE, ActuatePacket>(
                         env, "Command::Actuate"));
  obj.Set("Trigger", factory<Property::CMD_TRIGGER, Uint16Packet>(
                         env, "Command::Trigger"));
  obj.Set("MirrorStream", factory<Property::CMD_STREAM, MirrorStreamPacket>(
                              env, "Command::MirrorStream"));
  auto frame =
      factory<Property::CMD_FRAME, FramePacket>(env, "Command::Frame");
  auto frameAccepted = factory<Property::CMD_FRAME, FrameAcceptedPacket>(
      env, "Command::FrameAccepted");
  auto frameResult = factory<Property::CMD_FRAME, FrameResultPacket>(
      env, "Command::FrameResult");
  obj.Set("Frame", frame);
  obj.Set("FrameAccepted", frameAccepted);
  obj.Set("FrameResult", frameResult);
  // DeviceObject::send substitutes these for CMD_FRAME's ACK/FIN decode,
  // since (unlike Actuate/Trigger/MirrorStream) its response shapes differ
  // from the request shape.
  frameAcceptedFactory.get(env) = Napi::Persistent(frameAccepted);
  frameResultFactory.get(env) = Napi::Persistent(frameResult);
  obj.Freeze();
  return obj;
};
}; // namespace Command

// Protocol v2 two-phase properties: ACK resolves `.accepted`, FIN resolves
// the terminal value. Deliberately narrower than the plan text's "everything
// but CMD_*" — CMD_STREAM is protocol-level single-phase (ACK/REJ only, no
// FIN ever sent, see docs/refactor/synced-capture.md §3.2/§9); treating it as
// two-phase here would leave every CMD_STREAM request's pending-map entry
// stuck until the connection closes, since no FIN would ever arrive to erase
// it. Gated additionally per-device by `DeviceObject::v2_capable` (P3.1a) —
// this only says which properties *could* be two-phase on v2 firmware, not
// whether *this* connection has confirmed it's talking to v2 firmware.
static inline bool isTwoPhase(Property p) {
  return p == Property::CMD_ACTUATE || p == Property::CMD_TRIGGER ||
        p == Property::CMD_FRAME;
}

class PendingRequest : public Shared<PendingRequest> {
public:
  const Napi::Env env;

private:
  bool accepted_settled = false;
  bool completed_settled = false;
  Dispatcher::Future completed_future = {env};
  // Only constructed for two-phase requests (see isTwoPhase) — never
  // resolving/rejecting an unused Future avoids both the extra uv uv_async
  // ref-count churn and (more importantly) an unhandled-rejection warning
  // for single-phase requests, which have no use for it.
  std::optional<Dispatcher::Future> accepted_future;

public:
  const uint16_t sequence;
  const Property property;
  const bool two_phase;
  // Decodes the ACK payload; for everything except CMD_FRAME this is the
  // same function as fin_factory (the request shape IS the response shape —
  // see Command::ActuatePacket/MirrorStreamPacket). CMD_FRAME's ACK
  // (FrameAccepted) and FIN (FrameResult) shapes differ, so DeviceObject::
  // send supplies two distinct factories for it.
  Napi::Reference<Napi::Function> ack_factory;
  Napi::Reference<Napi::Function> fin_factory;

  PendingRequest(Napi::Env env, uint16_t sequence, Property property,
                 bool two_phase,
                 Napi::Function ackFn, Napi::Function finFn)
      : env(env), sequence(sequence), property(property), two_phase(two_phase),
        ack_factory(Napi::Persistent(ackFn)),
        fin_factory(Napi::Persistent(finFn)) {
    if (two_phase)
      accepted_future.emplace(env);
  }

  ~PendingRequest() {
    try {
      auto timeout = [&] { return Napi::Error::New(env, "Request timeout").Value(); };
      if ((two_phase && !accepted_settled) || !completed_settled) {
        std::string unsettled;
        if (two_phase && !accepted_settled)
          unsettled = "accepted";
        if (!completed_settled) {
          if (!unsettled.empty())
            unsettled += "|";
          unsettled += "completed";
        }
        VERBOSE("trace drop seq=%u unsettled=%s", sequence,
                unsettled.c_str());
      }
      if (two_phase && !accepted_settled) {
        accepted_settled = true;
        accepted_future->Reject(timeout());
      }
      if (!completed_settled) {
        completed_settled = true;
        completed_future.Reject(timeout());
      }
    } catch (...) {
      // Allow silently fail during module cleanup
    }
  }

  // ACK: for single-phase properties this IS the terminal resolution
  // (matches the pre-v2 behavior exactly); for two-phase properties it only
  // resolves `.accepted` — the entry stays pending for FIN.
  inline void ResolveAck(Napi::Value value) {
    const char *phase = two_phase ? "accepted" : "completed";
    try {
      auto decoded =
          ack_factory.IsEmpty() ? value : ack_factory.Value().Call({value});
      if (two_phase) {
        accepted_future->Resolve(decoded);
        accepted_settled = true;
      } else {
        completed_future.Resolve(decoded);
        completed_settled = true;
      }
      VERBOSE("trace resolve seq=%u phase=%s ok", sequence, phase);
    } catch (const Napi::Error &e) {
      ERROR("trace resolve seq=%u phase=%s FAILED: %s", sequence, phase,
            e.Message().c_str());
      Reject(e.Value());
    } catch (const std::exception &e) {
      ERROR("trace resolve seq=%u phase=%s FAILED: %s", sequence, phase,
            e.what());
      Reject(Napi::Error::New(env, e.what()).Value());
    } catch (...) {
      ERROR("trace resolve seq=%u phase=%s FAILED: unknown error", sequence,
            phase);
      Reject(Napi::Error::New(env, "Unknown response decode/resolve error")
                 .Value());
    }
  }
  // FIN: only ever sent for two-phase properties.
  inline void ResolveFin(Napi::Value value) {
    try {
      auto decoded =
          fin_factory.IsEmpty() ? value : fin_factory.Value().Call({value});
      completed_future.Resolve(decoded);
      completed_settled = true;
      VERBOSE("trace resolve seq=%u phase=completed ok", sequence);
    } catch (const Napi::Error &e) {
      ERROR("trace resolve seq=%u phase=completed FAILED: %s", sequence,
            e.Message().c_str());
      Reject(e.Value());
    } catch (const std::exception &e) {
      ERROR("trace resolve seq=%u phase=completed FAILED: %s", sequence,
            e.what());
      Reject(Napi::Error::New(env, e.what()).Value());
    } catch (...) {
      ERROR("trace resolve seq=%u phase=completed FAILED: unknown error",
            sequence);
      Reject(Napi::Error::New(env, "Unknown response decode/resolve error")
                 .Value());
    }
  }
  // Rejects whichever phase(s) are still outstanding (REJ is terminal at
  // either phase — see docs/refactor/synced-capture.md §3.1).
  inline void Reject(Napi::Value reason) {
    if (two_phase && !accepted_settled) {
      accepted_settled = true;
      accepted_future->Reject(reason);
    }
    if (!completed_settled) {
      completed_settled = true;
      completed_future.Reject(reason);
    }
  }
  inline Napi::Promise CompletedPromise() { return completed_future.Promise(); }
  inline Napi::Promise AcceptedPromise() { return accepted_future->Promise(); }
};

extern int SerialOpen(const Napi::CallbackInfo &info) noexcept;

class DeviceObject : public ObjectWrap<DeviceObject> {
public:
  static Function Init(Napi::Env env) {
    return DefineClass(env, "Protocol",
                       {
                           INSTANCE_GETTER(DeviceObject, connected),     //
                           INSTANCE_GETTER(DeviceObject, v2Capable),     //
                           INSTANCE_GETTER(DeviceObject, stats),         //
                           INSTANCE_METHOD(DeviceObject, get),           //
                           INSTANCE_METHOD(DeviceObject, set),           //
                           INSTANCE_METHOD(DeviceObject, fireAndForget), //
                           INSTANCE_METHOD(DeviceObject, verifyVersion), //
                           INSTANCE_METHOD(DeviceObject, release),       //
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
  struct {
    std::atomic<uint64_t> txBytes = 0;
    std::atomic<uint64_t> rxBytes = 0;
    std::atomic<uint64_t> txPackets = 0;
    std::atomic<uint64_t> rxPackets = 0;
  } counters;
  // Napi::FunctionReference __tx__;
  uint16_t __sequence__ = 0;
  inline uint16_t sequence() {
    if (__sequence__ == 0)
      __sequence__ = 1;
    return __sequence__++;
  }

  // Safe-by-default (P3.1a, docs/refactor/synced-capture.md §9.3): stays
  // false — meaning every property, including CMD_ACTUATE/TRIGGER/FRAME,
  // resolves on ACK exactly like v1 firmware always behaved — until
  // verifyVersion() confirms firmware major >= Protocol::Version::Major.
  // Without this, a rebuilt (v2) host talking to old (v1) firmware would
  // hang forever awaiting a FIN the firmware never sends.
  bool v2_capable = false;

  GET(connected) { return Napi::Boolean::New(env, !flag_term); }
  GET(v2Capable) { return Napi::Boolean::New(env, v2_capable); }
  GET(stats) {
    auto obj = Napi::Object::New(env);
    obj.Set("txBytes", Napi::Number::New(env, counters.txBytes.load()));
    obj.Set("rxBytes", Napi::Number::New(env, counters.rxBytes.load()));
    obj.Set("txPackets", Napi::Number::New(env, counters.txPackets.load()));
    obj.Set("rxPackets", Napi::Number::New(env, counters.rxPackets.load()));
    return obj;
  }

  void recordTx(ssize_t bytes) {
    if (bytes <= 0)
      return;
    counters.txBytes.fetch_add(static_cast<uint64_t>(bytes));
    counters.txPackets.fetch_add(1);
  }

  inline void handleRawPacket(Protocol::RawPacket &&packet) noexcept {
    try {
      auto header = packet.validate();
      if (header == Protocol::INVALID)
        throw std::invalid_argument("Corrupted packet");
      counters.rxPackets.fetch_add(1);
      const auto method = Protocol::method(header);
      const auto property = Protocol::property(header);
      const auto &sequence = packet.header().sequence;
      VERBOSE("recv %s:%s (seq=%u) payload %zu bytes",
              convert<std::string>(method).c_str(),
              convert<std::string>(property).c_str(), sequence,
              packet.dataSize());
      auto p = pending.ref();
      if (p->has(sequence)) {
        auto pr = p->at(sequence);
        // Two-phase requests keep their pending-map entry across the ACK —
        // only FIN/REJ retire it (see PendingRequest::two_phase and
        // docs/refactor/synced-capture.md §3.1/§5).
        bool retire = !(pr->two_phase && method == Method::ACK &&
                        property == pr->property);
        VERBOSE("trace rx seq=%u %s:%s matched=1 retire=%d pending=%s",
                sequence, convert<std::string>(method).c_str(),
                convert<std::string>(property).c_str(), retire ? 1 : 0,
                pendingSequences(*p).c_str());
        Dispatcher::dispatch(env, [pr, method, property, sequence,
                                   packet = std::move(packet)](napi_env env) {
          auto payload = ArrayBuffer::New(env, packet.dataSize());
          std::memcpy(payload.Data(), packet.data(), packet.dataSize());
          const char *branch =
              method == Method::ACK && property == pr->property
                  ? "ack"
                  : method == Method::FIN && property == pr->property
                        ? "fin"
                        : method == Method::REJ ? "rej" : "unexpected";
          VERBOSE(
              "trace task seq=%u branch=%s two_phase=%d payload=%zu first8=%s",
              sequence, branch, pr->two_phase ? 1 : 0, packet.dataSize(),
              hexPreview(packet.data(), packet.dataSize()).c_str());
          try {
            if (method == Method::ACK && property == pr->property) {
              pr->ResolveAck(payload);
            } else if (method == Method::FIN && property == pr->property) {
              pr->ResolveFin(payload);
            } else if (method == Method::REJ) {
              // REJ packets always have a string payload
              auto reason =
                  std::string((char *)payload.Data(), payload.ByteLength());
              pr->Reject(Napi::Error::New(pr->env, reason).Value());
            } else {
              pr->Reject(
                  Napi::Error::New(pr->env,
                                   "Unexpected response " +
                                       convert<std::string>(method) + ":" +
                                       convert<std::string>(property))
                      .Value());
            }
          } catch (const Napi::Error &e) {
            ERROR("trace task seq=%u branch=%s FAILED: %s", sequence, branch,
                  e.Message().c_str());
            pr->Reject(e.Value());
          } catch (const std::exception &e) {
            ERROR("trace task seq=%u branch=%s FAILED: %s", sequence, branch,
                  e.what());
            pr->Reject(Napi::Error::New(pr->env, e.what()).Value());
          } catch (...) {
            ERROR("trace task seq=%u branch=%s FAILED: unknown error",
                  sequence, branch);
            pr->Reject(Napi::Error::New(pr->env, "Unknown response error")
                           .Value());
          }
        });
        if (retire)
          p->erase(sequence);
      } else if (method == Method::SYN && property == Property::LOG) {
        // Unsolicited log packet
        std::string log_msg((char *)packet.data(), packet.dataSize());
        __LOG__("%s", "PORT ", GREEN, "Device", log_msg.c_str());
      } else if (sequence != 0) {
        VERBOSE("trace rx seq=%u %s:%s matched=0 retire=0 pending=%s",
                sequence, convert<std::string>(method).c_str(),
                convert<std::string>(property).c_str(),
                pendingSequences(*p).c_str());
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
      counters.rxBytes.fetch_add(static_cast<uint64_t>(count));
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
        // CMD_FRAME's ACK (FrameAccepted) and FIN (FrameResult) payloads
        // differ in shape from each other and from the request `factory`
        // (Command::Frame) — substitute the dedicated decoders cached by
        // Command::Init. Every other property's ACK/FIN (if any) echoes the
        // request shape, so `factory` decodes both.
        auto ackFactory = factory;
        auto finFactory = factory;
        if (property == Property::CMD_FRAME) {
          ackFactory = frameAcceptedFactory.get(env).Value();
          finFactory = frameResultFactory.get(env).Value();
        }
        // Register the pending request before writing. V2 firmware can ACK+FIN
        // a zero-settle ACTUATE quickly enough that a write-first order drops
        // the response as "unmatched" on the rx thread.
        bool two_phase = isTwoPhase(property) && v2_capable;
        auto pr = PendingRequest::create(env, sequence, property, two_phase,
                                         ackFactory, finFactory);
        auto completed = pr->CompletedPromise();
        if (pr->two_phase) {
          auto accepted = pr->AcceptedPromise();
          // Attach a no-op catch so an app that only awaits the returned
          // (completed) promise — never touching `.accepted` — doesn't
          // trigger an unhandled-rejection warning if the request REJects
          // at the ACK phase (both promises reject in that case, see
          // PendingRequest::Reject). The caller can still attach its own
          // handler(s) to the same `.accepted` promise independently.
          auto noop = Napi::Function::New(
              env, [](const Napi::CallbackInfo &) { return; });
          accepted.Get("catch").As<Napi::Function>().Call(accepted, {noop});
          completed.Set("accepted", accepted);
        }
        pending.ref()->set(sequence, pr);
        VERBOSE("trace tx seq=%u %s:%s two_phase=%d v2_capable=%d bytes=%u",
                sequence,
                convert<std::string>(Protocol::method(packet.header().header))
                    .c_str(),
                convert<std::string>(property).c_str(), two_phase ? 1 : 0,
                v2_capable ? 1 : 0, tx.size());
        VERBOSE("send %u bytes: %s", tx.size(),
                hexFormat(tx.data(), tx.size()).c_str());
        // Write buffer to serial fd
        auto written = ::write(fd, tx.data(), tx.size());
        VERBOSE("wrote %zd bytes to fd %d", written, fd);
        if (written < 0) {
          pending.ref()->erase(sequence);
          JS_THROW(Error,
                   "Failed to write to serial port: " +
                       std::string(std::strerror(errno)),
                   env.Undefined());
        }
        if (written != static_cast<ssize_t>(tx.size())) {
          pending.ref()->erase(sequence);
          JS_THROW(Error, "Incomplete write to serial port", env.Undefined());
        }
        recordTx(written);
        return completed;
      } else {
        throw JS::Error(env, "Failed to encode packet");
      }
    }
    JS_EXCEPT(env.Null())
  }

  FN(get) {
    auto env = info.Env();
    if (info.Length() < 1)
      JS_THROW(TypeError, "Device::get expects at least one argument",
               env.Undefined());
    const auto &factory = info[0].As<Napi::Function>();
    const auto property = getProperty(factory);
    const auto sequence = this->sequence();
    Protocol::RawPacket packet(Method::GET, property, sequence);
    if (info.Length() > 1) {
      // Most GETs are payload-less reads; CMD_FRAME's GET is a request
      // carrying {stream, cameras, pulse} — same optional-payload shape as
      // set() below.
      auto buffer = getBuffer(factory.Call({info[1]}));
      if (!isBufferLike(buffer))
        JS_THROW(TypeError,
                 "Packet factory must return an array buffer like object",
                 env.Undefined());
      packet.setData(bufferView(buffer));
    }
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

  // Protocol::Sequence == 0 fire-and-forget (docs/refactor/synced-capture.md
  // §3.1): the firmware performs the SET but sends no ACK/FIN/REJ at all —
  // used for high-rate stream position updates (CMD_STREAM UPDATE, ~1kHz).
  // No pending-map entry, no promise; a write failure throws synchronously.
  FN(fireAndForget) {
    auto env = info.Env();
    if (info.Length() < 1)
      JS_THROW(TypeError, "Device::fireAndForget expects at least one argument",
               env.Undefined());
    const auto &factory = info[0].As<Napi::Function>();
    const auto property = getProperty(factory);
    Protocol::RawPacket packet(Method::SET, property, 0);
    if (info.Length() > 1) {
      auto buffer = getBuffer(factory.Call({info[1]}));
      if (!isBufferLike(buffer))
        JS_THROW(TypeError,
                 "Packet factory must return an array buffer like object",
                 env.Undefined());
      packet.setData(bufferView(buffer));
    }
    try {
      if (!tx.encode(packet.finalize()))
        throw JS::Error(env, "Failed to encode packet");
      VERBOSE("trace tx seq=0 SET:%s two_phase=0 v2_capable=%d bytes=%u",
              convert<std::string>(property).c_str(), v2_capable ? 1 : 0,
              tx.size());
      auto written = ::write(fd, tx.data(), tx.size());
      if (written < 0)
        JS_THROW(Error,
                 "Failed to write to serial port: " +
                     std::string(std::strerror(errno)),
                 env.Undefined());
      if (written != static_cast<ssize_t>(tx.size()))
        JS_THROW(Error, "Incomplete write to serial port", env.Undefined());
      recordTx(written);
    }
    JS_EXCEPT(env.Undefined())
    return env.Undefined();
  }

  // P3.1a (docs/refactor/synced-capture.md §9.3): fetches SYS_VERSION and
  // sets v2_capable = (firmware.major >= Protocol::Version::Major). Until
  // this resolves (or if it's never called), v2_capable stays false and
  // every property behaves single-phase — safe against v1 firmware, just
  // not two-phase-accurate against v2 firmware. Returns the decoded version
  // plus the `compatible` verdict; never rejects on a *version mismatch*
  // (only on a transport/REJ failure), matching the plan's "recommended"
  // fallback over an outright refusal.
  FN(verifyVersion) {
    auto env = info.Env();
    const auto sequence = this->sequence();
    Protocol::RawPacket packet(Method::GET, Property::SYS_VERSION, sequence);
    // Identity decoder: read the raw ACK payload as Packet::System::Version
    // directly below, no need to round-trip through the JS-facing
    // Protocol.System.Version factory for an internal-only check.
    auto identity = Napi::Function::New(
        env, [](const Napi::CallbackInfo &info) -> Napi::Value {
          return info[0];
        });
    auto value = send(sequence, Property::SYS_VERSION, identity, packet);
    if (!value.IsPromise())
      return value; // send() already threw/returned null on failure
    auto self = this;
    auto onFulfilled = Napi::Function::New(
        env, [self](const Napi::CallbackInfo &info) -> Napi::Value {
          auto env = info.Env();
          auto buffer = info[0].As<Napi::ArrayBuffer>();
          if (buffer.ByteLength() < sizeof(Packet::System::Version))
            throw JS::Error(env, "Malformed System::Version response");
          auto version = *reinterpret_cast<const Packet::System::Version *>(
              buffer.Data());
          bool compatible = version.major >= Protocol::Version::Major;
          self->v2_capable = compatible;
          auto result = Napi::Object::New(env);
          result.Set("major", Napi::Number::New(env, version.major));
          result.Set("minor", Napi::Number::New(env, version.minor));
          result.Set("patch", Napi::Number::New(env, version.patch));
          result.Set("compatible", Napi::Boolean::New(env, compatible));
          return result;
        });
    auto promise = value.As<Napi::Promise>();
    return promise.Get("then").As<Napi::Function>().Call(promise,
                                                          {onFulfilled});
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
