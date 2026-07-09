// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// pairing-nodes P-1 NAPI seam: the per-stage L/R PAIRING brick (PairStream.h).
//   createPairStream(leftId, rightId, opts) -> a create-only CoreObject
//     leftId/rightId = live convert | undistort | fovea | scale pipe ids (or a
//                      test source, below). opts = { mode?: "root"|"exact",
//                      stage?, anchorFrom?, toleranceNs?, leftDeltaNs?,
//                      rightDeltaNs?, anchorCap?, pendingCap?, completedCap? }.
//     The object exposes: pushAnchor({tExposure, stream, payload?}), probe(),
//     [Symbol.asyncIterator] (batched pair RECORDS), release()/ref().
//   createPairTestSource(id)  — a synthetic ConvertedFrame producer (test-only).
//   pushPairTestFrame(id, {deviceTimestamp, width?, height?, originX?, originY?})
//   releasePairTestSource(id) — idempotent.
// The pairing brick is NOT in a demand-gated pipe registry (it is always-running
// and record-output, not a pipe); a weak-ref registry backs Topology.report().

#include <map>
#include <memory>
#include <mutex>

#include <opencv2/opencv.hpp>

#include <CoreObject.h>
#include <Iterator.h> // Sub::Queue / Sub::Iterator (async-generator seam)
#include <Topology.h>
#include <napi-helper.h>

#include "ConverterStream.h" // findConverter, ConvertedFrame, OwnedFrame
#include "FoveaStream.h"     // findFovea
#include "PairStream.h"
#include "ScaleStream.h"     // findScale
#include "UndistortStream.h" // findUndistort

using namespace Napi;

namespace Arv {

// ---- test-only synthetic ConvertedFrame producer ---------------------------
// A push-driven Stream<ConvertedFrame::Ptr>: `pushFrame` enqueues a frame with
// an EXPLICIT deviceTimestamp (the fake camera can't control those, so the join
// test needs this). The brick thread's iterate() blocks on the internal FIFO;
// a subscribed PairStream tap wakes it.
class PushSourceStream : public ::Stream<ConvertedFrame::Ptr> {
public:
  using Ptr = std::shared_ptr<PushSourceStream>;
  ~PushSourceStream() {
    fifo_.close();
    shutdown();
  }
  void pushFrame(const ConvertedFrame::Ptr &f) {
    ConvertedFrame::Ptr copy = f;
    fifo_.write(copy);
  }

protected:
  void start() override {}
  void stop() override {}
  ConvertedFrame::Ptr iterate() override {
    try {
      return fifo_.read(); // blocks; EOS on close -> StopIteration
    } catch (Threading::EOS &) {
      throw StopIteration();
    }
  }

private:
  Threading::FIFO<ConvertedFrame::Ptr> fifo_; // unbounded (test cadence is low)
};

static std::mutex g_srcMutex;
static std::map<std::string, PushSourceStream::Ptr> g_testSources;

PairStream::Source findPairTestSource(const std::string &id) {
  std::scoped_lock lk(g_srcMutex);
  auto it = g_testSources.find(id);
  return it != g_testSources.end()
             ? std::static_pointer_cast<::Stream<ConvertedFrame::Ptr>>(
                   it->second)
             : nullptr;
}

// ---- pairing-brick weak registry (Topology.report only) --------------------
static std::mutex g_pairMutex;
static std::map<std::string, std::weak_ptr<PairStream>> g_pairs;

PairStream::Ptr findPair(const std::string &stage) {
  std::scoped_lock lk(g_pairMutex);
  auto it = g_pairs.find(stage);
  return it != g_pairs.end() ? it->second.lock() : nullptr;
}

// Resolve one input id to a live ConvertedFrame producer (test source first,
// then the standard bricks — same set StereoStream accepts).
static PairStream::Source resolvePairSource(const std::string &id) {
  if (auto t = findPairTestSource(id))
    return t;
  if (auto und = findUndistort(id))
    return und;
  if (auto conv = findConverter(id))
    return conv;
  if (auto fov = findFovea(id))
    return fov;
  if (auto sc = findScale(id))
    return sc;
  return nullptr;
}

// ---- PairBatch -> JS records (never the pinned buffers) --------------------
static Napi::Object frameIdentity(Napi::Env env, const OwnedFrame::Ptr &f) {
  auto o = Napi::Object::New(env);
  o.Set("deviceTimestamp", convert(env, f->deviceTimestamp)); // uint64 -> BigInt
  o.Set("width", Napi::Number::New(env, f->width()));
  o.Set("height", Napi::Number::New(env, f->height()));
  o.Set("originX", Napi::Number::New(env, f->originX));
  o.Set("originY", Napi::Number::New(env, f->originY));
  o.Set("seq", Napi::Number::New(env, static_cast<double>(f->seq)));
  return o;
}

} // namespace Arv (part 1) — the convert specializations must be GLOBAL (the
  // primary template's namespace) so unqualified `convert` inside Arv is not
  // shadowed by them (matches Tracker.cpp's global MultiTrackResult convert).

// ---- PairBatch -> JS records (never the pinned buffers) --------------------
template <>
Napi::Value convert(Napi::Env env, const Arv::PairBatch::Ptr &b) noexcept {
  if (!b)
    return env.Null();
  auto arr = Napi::Array::New(env, b->records.size());
  for (size_t i = 0; i < b->records.size(); i++) {
    const auto &rec = b->records[i];
    auto o = Napi::Object::New(env);
    o.Set("anchorId", Napi::Number::New(env, static_cast<double>(rec.anchor.id)));
    o.Set("tExposure", convert(env, rec.anchor.tExposure));
    o.Set("stream", Napi::Number::New(env, rec.anchor.stream));
    auto payload = Napi::Float64Array::New(env, rec.anchor.payload.size(),
                                           napi_float64_array);
    if (!rec.anchor.payload.empty())
      std::memcpy(payload.Data(), rec.anchor.payload.data(),
                  rec.anchor.payload.size() * sizeof(double));
    o.Set("payload", payload);
    o.Set("left", Arv::frameIdentity(env, rec.left));
    o.Set("right", Arv::frameIdentity(env, rec.right));
    arr.Set(static_cast<uint32_t>(i), o);
  }
  auto out = Napi::Object::New(env);
  out.Set("records", arr);
  return out;
}
template <>
Napi::Value convert(Napi::Env env, const Napi::Value &,
                    const Arv::PairBatch::Ptr &b) noexcept {
  return convert(env, b);
}

namespace Arv {

// ---- the create-only CoreObject over a PairStream --------------------------
class PairObject : public CoreObject<PairObject, PairStream::Ptr> {
public:
  static inline const std::string name = "PairStream";
  static std::string describe(const PairObject *) { return "PairStream"; }
  // Drop the topology weak-ref before the native brick is destructed (its
  // teardown joins the brick thread).
  static void destruct(PairObject *self) {
    if (!self)
      return;
    const auto stage = self->core()->name();
    std::scoped_lock lk(g_pairMutex);
    g_pairs.erase(stage);
  }

  static Napi::Function Init(Napi::Env env) {
    auto asyncIterator = Napi::Symbol::WellKnown(env, "asyncIterator");
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(PairObject, env),
            INSTANCE_METHOD(PairObject, pushAnchor),
            INSTANCE_METHOD(PairObject, pushResolvedAnchor),
            INSTANCE_METHOD(PairObject, probe),
            Napi::InstanceWrap<PairObject>::template InstanceMethod<
                &PairObject::asyncIterator>(asyncIterator),
        });
  }

  CORE_OBJECT_DECL(PairObject)

  PairObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  // pushAnchor({ tExposure: bigint, stream: number, payload?: Float64Array }).
  FN(pushAnchor) {
    auto env = info.Env();
    try {
      JS_ASSERT(info[0].IsObject(), TypeError,
                "pushAnchor: anchor object required", env.Undefined());
      auto o = info[0].As<Napi::Object>();
      JS_ASSERT(o.Has("tExposure"), TypeError,
                "pushAnchor: `tExposure` (bigint ns) required", env.Undefined());
      const int64_t tExposure = convert<int64_t>(o.Get("tExposure"));
      const int32_t stream =
          o.Has("stream") && o.Get("stream").IsNumber()
              ? o.Get("stream").As<Napi::Number>().Int32Value()
              : 0;
      const double *payload = nullptr;
      size_t n = 0;
      if (o.Has("payload") && !o.Get("payload").IsUndefined() &&
          !o.Get("payload").IsNull()) {
        auto buf = bufferView<double>(o.Get("payload"));
        payload = buf.data;
        n = buf.size;
      }
      const uint64_t id = core()->pushAnchor(tExposure, stream, payload, n);
      return Napi::Number::New(env, static_cast<double>(id));
    }
    JS_EXCEPT(env.Undefined())
  }

  // pushResolvedAnchor({ anchorId?, tExposure, stream?, leftKey, rightKey,
  //   payload? }) — the root→downstream key delivery (pairing-nodes ruling 2).
  // The root brick's completed pair carries left/right deviceTimestamps; the
  // session forwards them (loop-safe, FIN rate) as the exact-join keys for the
  // NEXT stage's `exact` brick. No frame is re-stamped (trusted-time).
  FN(pushResolvedAnchor) {
    auto env = info.Env();
    try {
      JS_ASSERT(info[0].IsObject(), TypeError,
                "pushResolvedAnchor: anchor object required", env.Undefined());
      auto o = info[0].As<Napi::Object>();
      JS_ASSERT(o.Has("leftKey") && o.Has("rightKey"), TypeError,
                "pushResolvedAnchor: `leftKey` and `rightKey` (bigint ns) required",
                env.Undefined());
      const int64_t leftKey = convert<int64_t>(o.Get("leftKey"));
      const int64_t rightKey = convert<int64_t>(o.Get("rightKey"));
      const int64_t tExposure =
          o.Has("tExposure") && !o.Get("tExposure").IsUndefined()
              ? convert<int64_t>(o.Get("tExposure"))
              : 0;
      const uint64_t anchorId =
          o.Has("anchorId") && o.Get("anchorId").IsNumber()
              ? static_cast<uint64_t>(o.Get("anchorId").As<Napi::Number>().DoubleValue())
              : 0;
      const int32_t stream =
          o.Has("stream") && o.Get("stream").IsNumber()
              ? o.Get("stream").As<Napi::Number>().Int32Value()
              : 0;
      const double *payload = nullptr;
      size_t n = 0;
      if (o.Has("payload") && !o.Get("payload").IsUndefined() &&
          !o.Get("payload").IsNull()) {
        auto buf = bufferView<double>(o.Get("payload"));
        payload = buf.data;
        n = buf.size;
      }
      const uint64_t id = core()->pushResolvedAnchor(anchorId, tExposure, stream,
                                                     leftKey, rightKey, payload, n);
      return Napi::Number::New(env, static_cast<double>(id));
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(probe) {
    auto env = info.Env();
    try {
      auto o = meterSnapshotToJs(env, core()->probe()).As<Napi::Object>();
      o.Set("anchorDrops",
            Napi::Number::New(env, static_cast<double>(core()->anchorDrops())));
      o.Set("leftDrops",
            Napi::Number::New(env, static_cast<double>(core()->leftDrops())));
      o.Set("rightDrops",
            Napi::Number::New(env, static_cast<double>(core()->rightDrops())));
      o.Set("completedDrops", Napi::Number::New(
                                  env, static_cast<double>(core()->completedDrops())));
      o.Set("pairsProduced", Napi::Number::New(
                                 env, static_cast<double>(core()->pairsProduced())));
      o.Set("anchorPoolSize", Napi::Number::New(
                                  env, static_cast<double>(core()->anchorPoolSize())));
      o.Set("mode", Napi::String::New(
                        env, core()->mode() == PairMode::Exact ? "exact" : "root"));
      return o;
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(asyncIterator) {
    auto env = info.Env();
    try {
      auto stream = core().get();
      auto queue = Sub::Queue<PairBatch::Ptr>::create(stream);
      Napi::Value it =
          Sub::Iterator<Sub::Queue<PairBatch::Ptr>>::Create(env, queue);
      if (it.IsObject())
        it.As<Napi::Object>().Set("upstream", info.This());
      return it;
    }
    JS_EXCEPT(env.Undefined())
  }
};

// ---- factories -------------------------------------------------------------
FN(createPairStream) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsString() && info[1].IsString(), TypeError,
              "createPairStream: leftId, rightId (strings) required",
              env.Undefined());
    const auto leftId = info[0].As<Napi::String>().Utf8Value();
    const auto rightId = info[1].As<Napi::String>().Utf8Value();
    Napi::Object opts = info[2].IsObject() ? info[2].As<Napi::Object>()
                                           : Napi::Object::New(env);

    std::string modeStr = opts.Has("mode") && opts.Get("mode").IsString()
                              ? opts.Get("mode").As<Napi::String>().Utf8Value()
                              : "root";
    JS_ASSERT(modeStr == "root" || modeStr == "exact", TypeError,
              "createPairStream: mode must be \"root\" or \"exact\"",
              env.Undefined());
    const PairMode mode = modeStr == "exact" ? PairMode::Exact : PairMode::Root;

    const std::string stage =
        opts.Has("stage") && opts.Get("stage").IsString()
            ? opts.Get("stage").As<Napi::String>().Utf8Value()
            : "pair/default";
    const std::string anchorFrom =
        opts.Has("anchorFrom") && opts.Get("anchorFrom").IsString()
            ? opts.Get("anchorFrom").As<Napi::String>().Utf8Value()
            : "controller";

    const int64_t toleranceNs =
        opts.Has("toleranceNs") && !opts.Get("toleranceNs").IsUndefined()
            ? convert<int64_t>(opts.Get("toleranceNs"))
            : 4'000'000; // 4 ms default (half a ~120fps min interval)
    const int64_t leftDeltaNs =
        opts.Has("leftDeltaNs") && !opts.Get("leftDeltaNs").IsUndefined()
            ? convert<int64_t>(opts.Get("leftDeltaNs"))
            : 0;
    const int64_t rightDeltaNs =
        opts.Has("rightDeltaNs") && !opts.Get("rightDeltaNs").IsUndefined()
            ? convert<int64_t>(opts.Get("rightDeltaNs"))
            : 0;

    PairCaps caps;
    auto capOpt = [&](const char *k, size_t &dst) {
      if (opts.Has(k) && opts.Get(k).IsNumber()) {
        const int v = opts.Get(k).As<Napi::Number>().Int32Value();
        if (v > 0)
          dst = static_cast<size_t>(v);
      }
    };
    capOpt("anchorCap", caps.anchors);
    capOpt("pendingCap", caps.pending);
    capOpt("completedCap", caps.completed);

    PairStream::Source left = resolvePairSource(leftId);
    JS_ASSERT(left != nullptr, Error,
              "createPairStream: no source brick on LEFT id " + leftId,
              env.Undefined());
    PairStream::Source right = resolvePairSource(rightId);
    JS_ASSERT(right != nullptr, Error,
              "createPairStream: no source brick on RIGHT id " + rightId,
              env.Undefined());

    auto stream = PairStream::create(std::move(left), leftId, std::move(right),
                                     rightId, anchorFrom, stage, mode,
                                     toleranceNs, leftDeltaNs, rightDeltaNs, caps);
    {
      std::scoped_lock lk(g_pairMutex);
      g_pairs[stage] = stream; // weak
    }
    stream->begin(); // always-running: open taps + run the join now
    return PairObject::Create(env, stream);
  }
  JS_EXCEPT(env.Undefined())
}

FN(createPairTestSource) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<Napi::String>().Utf8Value();
    std::scoped_lock lk(g_srcMutex);
    g_testSources[id] = std::make_shared<PushSourceStream>();
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

FN(pushPairTestFrame) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[1].IsObject(), TypeError,
              "pushPairTestFrame: frame descriptor object required",
              env.Undefined());
    auto o = info[1].As<Napi::Object>();
    PushSourceStream::Ptr src;
    {
      std::scoped_lock lk(g_srcMutex);
      auto it = g_testSources.find(id);
      if (it != g_testSources.end())
        src = it->second;
    }
    if (!src)
      return Boolean::New(env, false);

    const uint64_t deviceTimestamp = convert<uint64_t>(o.Get("deviceTimestamp"));
    const int w = o.Has("width") && o.Get("width").IsNumber()
                      ? o.Get("width").As<Napi::Number>().Int32Value()
                      : 8;
    const int h = o.Has("height") && o.Get("height").IsNumber()
                      ? o.Get("height").As<Napi::Number>().Int32Value()
                      : 8;
    auto cf = ConvertedFrame::create();
    cf->mat = cv::Mat(std::max(1, h), std::max(1, w), CV_8UC4, cv::Scalar(0));
    cf->format = BGRA8;
    cf->deviceTimestamp = deviceTimestamp;
    cf->systemTimestamp = deviceTimestamp;
    cf->originX = o.Has("originX") && o.Get("originX").IsNumber()
                      ? o.Get("originX").As<Napi::Number>().Uint32Value()
                      : 0;
    cf->originY = o.Has("originY") && o.Get("originY").IsNumber()
                      ? o.Get("originY").As<Napi::Number>().Uint32Value()
                      : 0;
    src->pushFrame(cf);
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

FN(releasePairTestSource) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<Napi::String>().Utf8Value();
    std::scoped_lock lk(g_srcMutex);
    return Boolean::New(env, g_testSources.erase(id) > 0);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- Topology.report() rows -------------------------------------------------
// kind "pair" (open styling set) with THREE inputs: <stage>-L -> pair (port
// "left"), <stage>-R -> pair (port "right"), controller -> pair (port
// "anchor"). Output null (records, not a pipe).
void appendPairReports(Napi::Env env, Napi::Array &rows,
                       std::set<std::string> &seen) {
  std::scoped_lock lk(g_pairMutex);
  for (const auto &[stage, weak] : g_pairs) {
    auto stream = weak.lock();
    if (!stream)
      continue;
    auto row = Topology::node(env, stage, "pair", "native");
    Topology::addInput(env, row, stream->leftId(), "left",
                       Topology::frameType(env, "BGRA8", "U8"));
    Topology::addInput(env, row, stream->rightId(), "right",
                       Topology::frameType(env, "BGRA8", "U8"));
    Topology::addInput(env, row, stream->anchorFrom(), "anchor",
                       Topology::frameType(env, "BGRA8", "U8"));
    row.Set("output", env.Null());
    row.Set("stats", meterSnapshotToJs(env, stream->probe()));
    rows.Set(rows.Length(), row);
    seen.insert(stage);
  }
}

} // namespace Arv
