// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Native PORT/PIPE NAPI seam: the three
// CoreObjects (`OutPort`, `InPort`, `PipeLink`), the pipe() connect (tag +
// payload-type checked, params validated with named invalid_arguments — the
// stereo-params precedent), the live-link registry feeding Topology.report()
// edges-only rows, and the hardware-free TEST source/sink hooks test 44/42
// drive (the createPairTestSource precedent — present but inert in
// production). The typed machinery lives in PortPipe.h; this TU only erases.
//
// JS surface (root-object-only namespace `core.Port`, like Recorder):
//   outPort.pipe(inPort, { type?: "latest"|"fifo"|"ring", depth?, size? })
//     → PipeLink { probe(), release() }   [release() = CoreObject release —
//       dropping the last JS ref disconnects + retires the topology edge]
//   Port.createTestTrackSource(nodeId) → { track_out, push(result), release }
//   Port.createTestTrackSink(nodeId, tag?, port?) →
//     { track_in, count(), seqs(), stall(ms), release }

#include <algorithm>
#include <chrono>
#include <cmath>
#include <mutex>
#include <vector>

#include <napi.h>

#include <Threading/Guard.h>
#include <TrackResult.h>

#include "CoreObject.h"
#include "PortPipe.h"
#include "Topology.h"
#include "napi-helper.h"

using namespace Napi;

namespace PortPipe {

// ---- live-link registry (NAPI thread registers; link release unregisters) ---
static std::mutex g_linksMutex;
static std::vector<Link *> g_links;

void registerLink(Link *link) {
  std::scoped_lock lk(g_linksMutex);
  g_links.push_back(link);
}

void unregisterLink(Link *link) {
  std::scoped_lock lk(g_linksMutex);
  g_links.erase(std::remove(g_links.begin(), g_links.end(), link),
                g_links.end());
}

// One EDGES-ONLY NodeReport row per live link: `{ id: toId, kind: "",
// edgesOnly: true, inputs: [{from, port, type, lossy}] }` — the JS fold unions
// the input into the consumer's real node (or synthesizes a placeholder whose
// kind derives from the id path). FIFO links carry the hwm/capacity on the
// edge; latest/ring are lossy.
void appendLinkReports(Napi::Env env, Napi::Array &rows) {
  std::scoped_lock lk(g_linksMutex);
  for (Link *l : g_links) {
    auto row = Topology::node(env, l->toId, "", "native");
    row.Set("edgesOnly", Boolean::New(env, true));
    auto type = Object::New(env);
    if (l->tag == "track" || l->tag == "detect") {
      type.Set("kind", String::New(env, l->tag));
    } else {
      type.Set("kind", String::New(env, "analysis"));
      type.Set("schema", String::New(env, l->tag));
    }
    const int lossy = l->type == LinkOptions::Type::Fifo ? 0 : 1;
    Topology::addInput(env, row, l->fromId, l->port, type, lossy);
    if (l->type == LinkOptions::Type::Fifo) {
      const LinkStats s = l->stats();
      auto inputs = row.Get("inputs").As<Array>();
      auto edge = inputs.Get(inputs.Length() - 1).As<Object>();
      auto q = Object::New(env);
      q.Set("highWater", Number::New(env, static_cast<double>(s.highWater)));
      q.Set("capacity", Number::New(env, static_cast<double>(s.capacity)));
      edge.Set("queue", q);
    }
    rows.Set(rows.Length(), row);
  }
}

// ---- pipe() options parse (NAPI thread; named invalid_arguments) ------------
// Strict per-type params (mirrors the d.ts discriminated union): `depth` only
// on fifo, `size` only on ring — a crossed param throws instead of silently
// ignoring (runtime and compile-time must agree).
LinkOptions parseLinkOptions(const Napi::Value &v) {
  LinkOptions o;
  if (v.IsUndefined() || v.IsNull())
    return o;
  if (!v.IsObject())
    throw std::invalid_argument("pipe options: must be an object");
  auto obj = v.As<Napi::Object>();
  std::string type = "latest";
  if (obj.Has("type") && !obj.Get("type").IsUndefined())
    type = obj.Get("type").As<Napi::String>().Utf8Value();
  const bool hasDepth = obj.Has("depth") && !obj.Get("depth").IsUndefined();
  const bool hasSize = obj.Has("size") && !obj.Get("size").IsUndefined();
  auto bound = [&](const char *key) -> size_t {
    const double raw = obj.Get(key).As<Napi::Number>().DoubleValue();
    if (!std::isfinite(raw) || raw < 1 || raw != std::floor(raw))
      throw std::invalid_argument(std::string("pipe options: `") + key +
                                  "` must be an integer >= 1");
    if (raw > 65536)
      throw std::invalid_argument(std::string("pipe options: `") + key +
                                  "` must be <= 65536");
    return static_cast<size_t>(raw);
  };
  if (type == "latest") {
    o.type = LinkOptions::Type::Latest;
    if (hasDepth || hasSize)
      throw std::invalid_argument(
          "pipe options: a \"latest\" link takes no `depth`/`size`");
  } else if (type == "fifo") {
    o.type = LinkOptions::Type::Fifo;
    if (hasSize)
      throw std::invalid_argument(
          "pipe options: a \"fifo\" link takes `depth`, not `size`");
    if (hasDepth)
      o.depth = bound("depth");
  } else if (type == "ring") {
    o.type = LinkOptions::Type::Ring;
    if (hasDepth)
      throw std::invalid_argument(
          "pipe options: a \"ring\" link takes `size`, not `depth`");
    if (hasSize)
      o.depth = bound("size");
  } else {
    throw std::invalid_argument(
        "pipe options: `type` must be \"latest\", \"fifo\" or \"ring\"");
  }
  return o;
}

} // namespace PortPipe

// The CoreObjects live at GLOBAL scope: the CORE_OBJECT macro specializes the
// global `convert` template, which is ill-formed inside another namespace
// (the ImmPredictor.cpp precedent).
using PortPipe::InPort;
using PortPipe::Link;
using PortPipe::LinkOptions;
using PortPipe::LinkStats;
using PortPipe::OutPort;

// ---- PipeLink CoreObject ------------------------------------------------------
// JS `release()` is the CoreObject release: dropping the wrapper's (only)
// shared_ptr runs ~LinkImpl → Link::release() → channel close + unsubscribe +
// join + topology retire. Idempotent (CoreObject contract).
class PipeLinkObject : public CoreObject<PipeLinkObject, Link::Ptr> {
public:
  static inline const std::string name = "PipeLink";
  static std::string describe(const PipeLinkObject *self) {
    try {
      const auto &l = self->core();
      return l->fromId + " -> " + l->toId;
    } catch (...) {
      return "released";
    }
  }

  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, name.c_str(),
                       {
                           CORE_OBJECT_REGISTER(PipeLinkObject, env),
                           INSTANCE_METHOD(PipeLinkObject, probe),
                       });
  }

  CORE_OBJECT_DECL(PipeLinkObject)

  PipeLinkObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  static void destruct(PipeLinkObject *self) {
    // Disconnect EAGERLY on JS release (don't wait for GC of stray refs).
    try {
      self->core()->release();
    } catch (...) {
    }
  }

  FN(probe) {
    auto env = info.Env();
    try {
      const LinkStats s = core()->stats();
      auto o = Object::New(env);
      o.Set("type", String::New(env, s.type));
      o.Set("capacity", Number::New(env, static_cast<double>(s.capacity)));
      o.Set("written", Number::New(env, static_cast<double>(s.written)));
      o.Set("delivered", Number::New(env, static_cast<double>(s.delivered)));
      o.Set("dropped", Number::New(env, static_cast<double>(s.dropped)));
      o.Set("highWater", Number::New(env, static_cast<double>(s.highWater)));
      o.Set("open", Boolean::New(env, s.open));
      o.Set("held", Boolean::New(env, s.held));
      return o;
    }
    JS_EXCEPT(env.Undefined())
  }
};

CORE_OBJECT(PipeLinkObject)

// ---- InPort CoreObject ----------------------------------------------------------
class InPortObject : public CoreObject<InPortObject, InPort::Ptr> {
public:
  static inline const std::string name = "InPort";
  static std::string describe(const InPortObject *self) {
    try {
      const auto &p = self->core();
      return p->nodeId + ":" + p->name + "<-" + p->tag;
    } catch (...) {
      return "released";
    }
  }

  static Napi::Function Init(Napi::Env env) {
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(InPortObject, env),
            Napi::InstanceWrap<InPortObject>::template InstanceAccessor<
                &InPortObject::get_node>("node", napi_enumerable),
            Napi::InstanceWrap<InPortObject>::template InstanceAccessor<
                &InPortObject::get_port>("port", napi_enumerable),
            Napi::InstanceWrap<InPortObject>::template InstanceAccessor<
                &InPortObject::get_streamTag>("streamTag", napi_enumerable),
        });
  }

  CORE_OBJECT_DECL(InPortObject)

  InPortObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  GET(node) { return String::New(info.Env(), core()->nodeId); }
  GET(port) { return String::New(info.Env(), core()->name); }
  GET(streamTag) { return String::New(info.Env(), core()->tag); }
};

CORE_OBJECT(InPortObject)

// ---- OutPort CoreObject ----------------------------------------------------------
class OutPortObject : public CoreObject<OutPortObject, OutPort::Ptr> {
public:
  static inline const std::string name = "OutPort";
  static std::string describe(const OutPortObject *self) {
    try {
      const auto &p = self->core();
      return p->nodeId + ":" + p->name + "->" + p->tag;
    } catch (...) {
      return "released";
    }
  }

  static Napi::Function Init(Napi::Env env) {
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(OutPortObject, env),
            INSTANCE_METHOD(OutPortObject, pipe),
            Napi::InstanceWrap<OutPortObject>::template InstanceAccessor<
                &OutPortObject::get_node>("node", napi_enumerable),
            Napi::InstanceWrap<OutPortObject>::template InstanceAccessor<
                &OutPortObject::get_port>("port", napi_enumerable),
            Napi::InstanceWrap<OutPortObject>::template InstanceAccessor<
                &OutPortObject::get_streamTag>("streamTag", napi_enumerable),
        });
  }

  CORE_OBJECT_DECL(OutPortObject)

  OutPortObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  GET(node) { return String::New(info.Env(), core()->nodeId); }
  GET(port) { return String::New(info.Env(), core()->name); }
  GET(streamTag) { return String::New(info.Env(), core()->tag); }

  FN(pipe); // defined below (needs InPortObject's convert + PipeLinkObject)
};

CORE_OBJECT(OutPortObject)

// outPort.pipe(inPort, opts?) — the ruled connect. Tag equality AND payload
// type_index equality are the connect-time type check (JS::TypeError); link
// params are validated with named invalid_arguments (mapped to JS Error).
Napi::Value OutPortObject::pipe(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    JS_ASSERT(info.Length() >= 1 && info[0].IsObject(), TypeError,
              "pipe: target InPort required", env.Undefined());
    InPort::Ptr in = convert<InPort::Ptr>(info[0]);
    const auto &out = core();
    if (out->tag != in->tag)
      throw JS::TypeError(env, "pipe: port tag mismatch — cannot pipe \"" +
                                   out->tag + "\" (" + out->nodeId + ":" +
                                   out->name + ") into \"" + in->tag + "\" (" +
                                   in->nodeId + ":" + in->name + ")");
    if (out->payload != in->payload)
      throw JS::TypeError(
          env, "pipe: payload type mismatch between \"" + out->nodeId + ":" +
                   out->name + "\" and \"" + in->nodeId + ":" + in->name +
                   "\" (same tag, different native payloads — fix the brick)");
    const LinkOptions opts = PortPipe::parseLinkOptions(info[1]);
    Link::Ptr link = out->connect(*in, opts);
    return PipeLinkObject::Create(env, link);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- JS wrapper factories (bricks hang ports via these) ----------------------
namespace PortPipe {
Napi::Value createOutPortJs(Napi::Env env, OutPort::Ptr port) {
  return OutPortObject::Create(env, port);
}
Napi::Value createInPortJs(Napi::Env env, InPort::Ptr port) {
  return InPortObject::Create(env, port);
}
} // namespace PortPipe

// =====================================================================
// TEST hooks (core/test/44 + 42) — a push-driven TrackResult source stream and
// a counting sink, both hardware-free (the createPairTestSource precedent).
// Registered in the Port namespace; inert unless a test constructs them.
// =====================================================================

class TrackPushStream : public ::Stream<TrackResult::Ptr> {
public:
  using Ptr = std::shared_ptr<TrackPushStream>;
  static Ptr create(std::string nodeId) {
    return std::make_shared<TrackPushStream>(std::move(nodeId));
  }
  explicit TrackPushStream(std::string nodeId) : nodeId_(std::move(nodeId)) {}
  ~TrackPushStream() {
    fifo_.close();
    shutdown();
  }
  const std::string &nodeId() const { return nodeId_; }
  void push(const TrackResult::Ptr &r) {
    TrackResult::Ptr copy = r;
    fifo_.write(copy);
  }

protected:
  void start() override {}
  void stop() override {}
  TrackResult::Ptr iterate() override {
    try {
      return fifo_.read(); // blocks; EOS on close → StopIteration
    } catch (Threading::EOS &) {
      throw StopIteration();
    }
  }

private:
  const std::string nodeId_;
  Threading::FIFO<TrackResult::Ptr> fifo_; // unbounded (test cadence)
};

static TrackResult::Ptr parseTrackResult(const Napi::Value &v) {
  auto o = v.As<Napi::Object>();
  auto r = TrackResult::create();
  r->found = o.Has("found") && o.Get("found").ToBoolean().Value();
  r->overridden =
      o.Has("overridden") && o.Get("overridden").ToBoolean().Value();
  const auto center = o.Get("center");
  if (center.IsObject()) {
    const auto c = center.As<Napi::Object>();
    r->center.x = c.Get("x").ToNumber().DoubleValue();
    r->center.y = c.Get("y").ToNumber().DoubleValue();
  }
  const auto bbox = o.Get("bbox");
  if (bbox.IsObject()) {
    const auto b = bbox.As<Napi::Object>();
    r->bbox = cv::Rect(
        static_cast<int>(b.Get("x").ToNumber().DoubleValue()),
        static_cast<int>(b.Get("y").ToNumber().DoubleValue()),
        static_cast<int>(b.Get("width").ToNumber().DoubleValue()),
        static_cast<int>(b.Get("height").ToNumber().DoubleValue()));
  }
  if (o.Has("seq"))
    r->seq = static_cast<uint64_t>(o.Get("seq").ToNumber().DoubleValue());
  if (o.Has("deviceTimestamp"))
    r->deviceTimestamp = convert<uint64_t>(o.Get("deviceTimestamp"));
  return r;
}

class TestTrackSourceObject
    : public CoreObject<TestTrackSourceObject, TrackPushStream::Ptr> {
public:
  static inline const std::string name = "TestTrackSource";
  static std::string describe(const TestTrackSourceObject *) {
    return "TestTrackSource";
  }

  static Napi::Function Init(Napi::Env env) {
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(TestTrackSourceObject, env),
            INSTANCE_METHOD(TestTrackSourceObject, push),
            Napi::InstanceWrap<TestTrackSourceObject>::template InstanceAccessor<
                &TestTrackSourceObject::get_track_out>("track_out",
                                                       napi_enumerable),
        });
  }

  CORE_OBJECT_DECL(TestTrackSourceObject)

  TestTrackSourceObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  FN(push) {
    auto env = info.Env();
    try {
      core()->push(parseTrackResult(info[0]));
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(track_out) {
    auto env = info.Env();
    try {
      if (trackOut_.IsEmpty()) {
        auto stream = core();
        auto port = PortPipe::makeOutPort<TrackResult::Ptr>(
            stream->nodeId(), "track", "track", stream, stream.get());
        auto js = PortPipe::createOutPortJs(env, port);
        trackOut_ = Napi::Persistent(js.As<Napi::Object>());
      }
      return trackOut_.Value();
    }
    JS_EXCEPT(env.Undefined())
  }

private:
  Napi::ObjectReference trackOut_; // cached port wrapper (accessor contract)
};

CORE_OBJECT(TestTrackSourceObject)

// Counting sink: records delivered seqs (order assertions) + an injectable
// per-item stall so tests can make the consumer provably SLOWER than the
// producer (drives latest shedding / fifo backpressure / ring drop-oldest).
struct TestTrackSinkCore : Shared<TestTrackSinkCore> {
  std::string nodeId, portName, tag;
  std::atomic<uint64_t> count{0};
  std::atomic<double> stallMs{0};
  // Test seam (44's throwing-sink case): deliveries BEYOND this count throw
  // out of the sink — proving a sink exception closes the channel (producer
  // ejects via EOS) instead of leaving a dead link open. 0 = never throw.
  std::atomic<uint64_t> throwAfter{0};
  Threading::Guard<std::vector<uint64_t>> seqs = {std::vector<uint64_t>()};
  InPort::Ptr port;
};

class TestTrackSinkObject
    : public CoreObject<TestTrackSinkObject, TestTrackSinkCore::Ptr> {
public:
  static inline const std::string name = "TestTrackSink";
  static std::string describe(const TestTrackSinkObject *) {
    return "TestTrackSink";
  }

  static Napi::Function Init(Napi::Env env) {
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(TestTrackSinkObject, env),
            INSTANCE_METHOD(TestTrackSinkObject, count),
            INSTANCE_METHOD(TestTrackSinkObject, seqs),
            INSTANCE_METHOD(TestTrackSinkObject, stall),
            INSTANCE_METHOD(TestTrackSinkObject, throwAfter),
            Napi::InstanceWrap<TestTrackSinkObject>::template InstanceAccessor<
                &TestTrackSinkObject::get_track_in>("track_in",
                                                    napi_enumerable),
        });
  }

  CORE_OBJECT_DECL(TestTrackSinkObject)

  TestTrackSinkObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  FN(count) {
    return Number::New(info.Env(),
                       static_cast<double>(core()->count.load()));
  }
  FN(seqs) {
    auto env = info.Env();
    try {
      auto ref = core()->seqs.ref();
      auto arr = Array::New(env, ref->size());
      for (size_t i = 0; i < ref->size(); i++)
        arr.Set(static_cast<uint32_t>(i),
                Number::New(env, static_cast<double>((*ref)[i])));
      return arr;
    }
    JS_EXCEPT(env.Undefined())
  }
  FN(stall) {
    auto env = info.Env();
    try {
      core()->stallMs.store(info[0].As<Napi::Number>().DoubleValue(),
                            std::memory_order_release);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }
  FN(throwAfter) {
    auto env = info.Env();
    try {
      core()->throwAfter.store(
          static_cast<uint64_t>(info[0].As<Napi::Number>().DoubleValue()),
          std::memory_order_release);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(track_in) {
    auto env = info.Env();
    try {
      if (trackIn_.IsEmpty()) {
        auto c = core();
        if (!c->port) {
          auto weakless = c; // sink captures the core (keeps it alive)
          c->port = PortPipe::makeInPort<TrackResult::Ptr>(
              c->nodeId, c->portName, c->tag,
              [weakless](const TrackResult::Ptr &r) {
                const double ms =
                    weakless->stallMs.load(std::memory_order_acquire);
                if (ms > 0)
                  std::this_thread::sleep_for(
                      std::chrono::duration<double, std::milli>(ms));
                // Throwing-sink seam (test 44): consume `throwAfter`
                // successful deliveries, then throw — exercising the
                // deliver() exit path that must close the channel.
                const uint64_t limit =
                    weakless->throwAfter.load(std::memory_order_acquire);
                if (limit > 0 && weakless->count.load() >= limit)
                  throw std::runtime_error("TestTrackSink: injected throw");
                if (r) {
                  auto ref = weakless->seqs.ref();
                  ref->push_back(r->seq);
                }
                weakless->count.fetch_add(1, std::memory_order_relaxed);
              });
        }
        auto js = PortPipe::createInPortJs(env, c->port);
        trackIn_ = Napi::Persistent(js.As<Napi::Object>());
      }
      return trackIn_.Value();
    }
    JS_EXCEPT(env.Undefined())
  }

private:
  Napi::ObjectReference trackIn_;
};

CORE_OBJECT(TestTrackSinkObject)

// Port.createTestTrackSource(nodeId) — push-driven TrackResult stream + port.
static FN(createTestTrackSource) {
  auto env = info.Env();
  try {
    const auto nodeId = info[0].As<Napi::String>().Utf8Value();
    auto stream = TrackPushStream::create(nodeId);
    return TestTrackSourceObject::Create(env, stream);
  }
  JS_EXCEPT(env.Undefined())
}

// Port.createTestTrackSink(nodeId, tag = "track", port = "measure").
static FN(createTestTrackSink) {
  auto env = info.Env();
  try {
    auto c = TestTrackSinkCore::create();
    c->nodeId = info[0].As<Napi::String>().Utf8Value();
    c->tag = info.Length() >= 2 && info[1].IsString()
                 ? info[1].As<Napi::String>().Utf8Value()
                 : "track";
    c->portName = info.Length() >= 3 && info[2].IsString()
                      ? info[2].As<Napi::String>().Utf8Value()
                      : "measure";
    return TestTrackSinkObject::Create(env, c);
  }
  JS_EXCEPT(env.Undefined())
}

// Root-object-only namespace export (`core.Port`, the Recorder precedent):
// registers the CoreObject classes (Create() needs them) + the test hooks.
#define EXPORT(OBJ, F) OBJ.Set(#F, Function::New<F>(env, #F));
void exportPortNamespace(Napi::Env env, Napi::Object &exports) {
  PipeLinkObject::Export(env, exports);
  InPortObject::Export(env, exports);
  OutPortObject::Export(env, exports);
  TestTrackSourceObject::Export(env, exports);
  TestTrackSinkObject::Export(env, exports);
  EXPORT(exports, createTestTrackSource);
  EXPORT(exports, createTestTrackSink);
}
#undef EXPORT
