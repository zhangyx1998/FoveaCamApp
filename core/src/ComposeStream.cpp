// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// NATIVE prediction COMPOSE brick. The pure JS `composeVolts` stays as the
// conformance reference. Joins the pid baseline with the IMM predictions in
// the Jacobian form:
//
//   V(t) = V_pid + J · (p_pred(t) − p_meas(t_pid))     per eye (J = 2×2)
//
// JS pushes the LINEARIZATION at each pid rebase (~60 Hz):
// `rebase({ vPid, pMeas, jL, jR, feedForward })` — `J` is the per-eye
// finite-difference of `followVolts` around `p_meas`, computed in the SESSION
// (JS owns calibration). Per prediction tick (~600 Hz off the imm brick's
// predict_out link) the brick emits final volts; `feedForward: false`
// (override drag / lost-gate / no calibration) holds the baseline
// (`predVolts = null` semantics). The BASELINE FLOOR lives here: the brick
// emits on BOTH every rebase (~60 Hz — mirrors always driven, warm or cold)
// and every prediction tick.
//
// Shape: a `Stream<VoltPair::Ptr>` producer whose thread blocks on an
// internal drop-oldest event ring (`Threading::Ring`); `pred_in` (tag
// "prediction") pushes prediction events from the link's delivery thread
// (non-blocking — never stalls the link); `rebase` pushes a floor event
// (nullptr). `volt_out` (tag "volts") pipes into the controller's native
// pos_in; an asyncIterator remains for the JS FALLBACK consumer (v1 firmware
// / no controller — JS is then a genuine consumer).

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <mutex>
#include <string>

#include <napi.h>

#include <Threading/Guard.h>
#include <Threading/Ring.h>

#include "CoreObject.h"
#include "ImmResult.h"
#include "Iterator.h" // Sub::Queue / Sub::Iterator (JS fallback consumer)
#include "PortPipe.h"
#include "ThreadMeter.h"
#include "VoltPair.h"
#include "napi-helper.h"
#include "utils/thread.h"

using namespace Napi;

// Shared full-schema meter serializer (defined in ConverterStream.cpp) — the
// same forward declaration Tracker.cpp / ImmPredictor.cpp use.
namespace Arv {
Napi::Value meterSnapshotToJs(Napi::Env env, const Meter::Snapshot &s);
}

static int64_t composeNowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
      .count();
}
static int64_t composeNowNs() {
  using namespace std::chrono;
  return duration_cast<nanoseconds>(steady_clock::now().time_since_epoch())
      .count();
}

// The rebase linearization (guarded — NAPI thread writes, brick thread reads).
struct ComposeRebase {
  double vPidLx = 0, vPidLy = 0, vPidRx = 0, vPidRy = 0;
  double pMeasX = 0, pMeasY = 0;
  // Row-major 2×2 per eye: [dVx/dpx, dVx/dpy, dVy/dpx, dVy/dpy].
  std::array<double, 4> jL{0, 0, 0, 0};
  std::array<double, 4> jR{0, 0, 0, 0};
  bool feedForward = false;
  bool warm = false; // false until the first rebase (emit the initial pose)
};

// Feed-forward STALENESS bound: predictions whose underlying MEASUREMENT
// (`measuredAtNs`) is older than this are not applied — floor AND prediction
// ticks degrade to the raw baseline. Default sized as ~3 prediction periods at
// the SLOWEST allowed rate (60 Hz → 50 ms), so it stays permissive across the
// 60–1000 Hz window; sessions that know the live rate pass a tighter bound via
// `staleAfterMs`.
static constexpr double kDefaultStaleAfterMs = 50.0;

// Volt-space delta clamp: the
// composed |J·Δp| contribution is clamped PER AXIS before it is added to the
// baseline. Belt-and-suspenders ABOVE the wire's hard floor (chPair ±dv/2 +
// volt2dac 0..65535 — verified, untouched): a legitimate feed-forward lead is
// a few volts; a runaway estimate would otherwise slam the pose to the range
// edge. The default is a quarter of the codec's 200 V full scale — far above
// any real lead, far below slam-to-edge; sessions that know the live `dv`
// pass a tighter fraction via `maxDeltaV`. The clamp lives HERE (not the
// MirrorSink) because only the brick sees the delta separately from the
// baseline — the sink only ever sees final composed volts.
static constexpr double kDefaultMaxDeltaV = 50.0;

class ComposeStream : public ::Stream<VoltPair::Ptr> {
public:
  using Ptr = std::shared_ptr<ComposeStream>;
  static Ptr create(std::string name, const VoltPair &initial,
                    double staleAfterMs = kDefaultStaleAfterMs,
                    double maxDeltaV = kDefaultMaxDeltaV) {
    return std::make_shared<ComposeStream>(std::move(name), initial,
                                           staleAfterMs, maxDeltaV);
  }
  ComposeStream(std::string name, const VoltPair &initial,
                double staleAfterMs = kDefaultStaleAfterMs,
                double maxDeltaV = kDefaultMaxDeltaV)
      : name_(name),
        meter_(std::move(name), {"pred", "rebase"}, {"volt"}, composeNowMs()),
        staleAfterNs_(static_cast<int64_t>(staleAfterMs * 1e6)),
        maxDeltaV_(maxDeltaV) {
    ComposeRebase r;
    r.vPidLx = initial.lx;
    r.vPidLy = initial.ly;
    r.vPidRx = initial.rx;
    r.vPidRy = initial.ry;
    *rebase_.ref() = r;
  }
  ~ComposeStream() {
    events_.close();
    shutdown();
  }

  const std::string &name() const { return name_; }

  // NAPI thread (~60 Hz): store the new linearization + push a FLOOR event so
  // the baseline is emitted even while the imm brick is cold.
  void rebase(const ComposeRebase &r) {
    {
      auto ref = rebase_.ref();
      *ref = r;
      ref->warm = true;
    }
    meter_.ingest("rebase", composeNowMs());
    events_.write(nullptr); // nullptr = floor tick
  }

  // pred_in sink (link delivery thread) — non-blocking drop-oldest push.
  void ingestPrediction(const ImmResult::Ptr &p) {
    if (!p)
      return;
    meter_.ingest("pred", composeNowMs());
    events_.write(p);
  }

  Meter::Snapshot probe() const { return meter_.probe(composeNowMs()); }

protected:
  void start() override { set_thread_name("compose"); }
  void stop() override {}

  VoltPair::Ptr iterate() override {
    ImmResult::Ptr ev;
    if (!events_.read(ev))
      throw StopIteration(); // ring closed — teardown
    // Cache the newest prediction on the brick thread; a FLOOR tick reuses it
    // against the NEW linearization, so a rebase no longer rescinds the
    // feed-forward lead (emitting the raw vPid floor instead would produce a
    // 60 Hz sawtooth of amplitude J·(pred − pMeas) that the MirrorSink dedupe
    // could never suppress). A brick that has NEVER seen a prediction still
    // emits the raw baseline — the cold-start intent ("mirrors always driven,
    // warm or cold") is preserved; only the dip is gone.
    if (ev)
      lastPred_ = ev;
    const ImmResult::Ptr &p = ev ? ev : lastPred_;
    const ComposeRebase r = *rebase_.ref();
    auto out = VoltPair::create();
    out->lx = r.vPidLx;
    out->ly = r.vPidLy;
    out->rx = r.vPidRx;
    out->ry = r.vPidRy;
    // Apply the ruled Jacobian delta when the LATEST prediction is usable —
    // healthy rebase + found + center + WITHIN the staleness bound (both tick
    // kinds; see fresh()). An unhealthy rebase, a coasted miss, a stale/absent
    // prediction, or a cold brick holds the baseline.
    if (p && r.warm && r.feedForward && p->found && p->hasCenter && fresh(p)) {
      const double dx = p->cx - r.pMeasX;
      const double dy = p->cy - r.pMeasY;
      // Guard 5: clamp the composed contribution per axis (see kDefaultMaxDeltaV).
      out->lx += clampDelta(r.jL[0] * dx + r.jL[1] * dy);
      out->ly += clampDelta(r.jL[2] * dx + r.jL[3] * dy);
      out->rx += clampDelta(r.jR[0] * dx + r.jR[1] * dy);
      out->ry += clampDelta(r.jR[2] * dx + r.jR[3] * dy);
    }
    meter_.emit("volt", composeNowMs());
    return out;
  }

private:
  // Staleness gate (refinement 1 / runaway guard 2): a prediction is usable
  // only while its underlying measurement is younger than the bound. An unset
  // stamp (measuredAtNs == 0 — a producer predating the field) counts as
  // stale; a non-positive bound disables the gate (test escape hatch).
  bool fresh(const ImmResult::Ptr &p) const {
    if (staleAfterNs_ <= 0)
      return true;
    return p->measuredAtNs > 0 &&
           composeNowNs() - p->measuredAtNs <= staleAfterNs_;
  }
  double clampDelta(double d) const {
    if (maxDeltaV_ <= 0)
      return d; // non-positive disables the clamp
    return std::min(maxDeltaV_, std::max(-maxDeltaV_, d));
  }

  const std::string name_;
  Meter::ThreadMeter meter_; // writer threads serialize per side (counters)
  Threading::Guard<ComposeRebase> rebase_ = {ComposeRebase{}};
  // Event ring: predictions + floor ticks. Drop-oldest, non-blocking producer
  // (a stalled emit path degrades the compose rate, never the link/NAPI).
  Threading::Ring<ImmResult::Ptr> events_{16};
  ImmResult::Ptr lastPred_;      // brick thread only (D2 floor reuse)
  const int64_t staleAfterNs_;   // feed-forward staleness bound
  const double maxDeltaV_;       // guard-5 per-axis |J·Δp| clamp (volts)
};

// --- convert: VoltPair → JS {left:{x,y}, right:{x,y}} -------------------------
template <> Napi::Value convert(Napi::Env env, const VoltPair::Ptr &v) noexcept {
  if (!v)
    return env.Null();
  auto o = Napi::Object::New(env);
  auto l = Napi::Object::New(env);
  l.Set("x", Napi::Number::New(env, v->lx));
  l.Set("y", Napi::Number::New(env, v->ly));
  auto r = Napi::Object::New(env);
  r.Set("x", Napi::Number::New(env, v->rx));
  r.Set("y", Napi::Number::New(env, v->ry));
  o.Set("left", l);
  o.Set("right", r);
  return o;
}
template <>
Napi::Value convert(Napi::Env env, const Napi::Value &,
                    const VoltPair::Ptr &v) noexcept {
  return convert(env, v);
}

// --- NAPI parse helpers -------------------------------------------------------
static void parseXY(const Napi::Value &v, double &x, double &y) {
  auto o = v.As<Napi::Object>();
  x = o.Get("x").ToNumber().DoubleValue();
  y = o.Get("y").ToNumber().DoubleValue();
}

static std::array<double, 4> parseJ(const Napi::Value &v, const char *key) {
  if (!v.IsArray())
    throw std::invalid_argument(std::string("compose rebase: `") + key +
                                "` must be a [4]-array (row-major 2x2)");
  auto a = v.As<Napi::Array>();
  if (a.Length() != 4)
    throw std::invalid_argument(std::string("compose rebase: `") + key +
                                "` must have exactly 4 elements");
  std::array<double, 4> j{};
  for (uint32_t i = 0; i < 4; i++) {
    const double e = a.Get(i).ToNumber().DoubleValue();
    if (!std::isfinite(e))
      throw std::invalid_argument(std::string("compose rebase: `") + key +
                                  "` must be finite");
    j[i] = e;
  }
  return j;
}

// =====================================================================
// ComposeObject — rebase / probe / pred_in / volt_out / [asyncIterator].
// =====================================================================
class ComposeObject : public CoreObject<ComposeObject, ComposeStream::Ptr> {
public:
  static inline const std::string name = "Compose";
  static std::string describe(const ComposeObject *) { return "Compose"; }

  static Napi::Function Init(Napi::Env env) {
    auto asyncIterator = Napi::Symbol::WellKnown(env, "asyncIterator");
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(ComposeObject, env),
            INSTANCE_METHOD(ComposeObject, rebase),
            INSTANCE_METHOD(ComposeObject, probe),
            Napi::InstanceWrap<ComposeObject>::template InstanceAccessor<
                &ComposeObject::get_pred_in>("pred_in", napi_enumerable),
            Napi::InstanceWrap<ComposeObject>::template InstanceAccessor<
                &ComposeObject::get_volt_out>("volt_out", napi_enumerable),
            // JS FALLBACK consumer (v1 firmware / no controller): volts via
            // the standard async-generator seam — JS is then a genuine
            // consumer (the native pos_in path skips this).
            Napi::InstanceWrap<ComposeObject>::template InstanceMethod<
                &ComposeObject::asyncIterator>(asyncIterator),
        });
  }

  CORE_OBJECT_DECL(ComposeObject)

  ComposeObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  // rebase({ vPid: {l:{x,y}, r:{x,y}}, pMeas: {x,y}, jL: [4], jR: [4],
  //          feedForward }) — named invalid_arguments (stereo-params style).
  FN(rebase) {
    auto env = info.Env();
    try {
      JS_ASSERT(info[0].IsObject(), TypeError,
                "compose rebase: params object required", env.Undefined());
      auto o = info[0].As<Napi::Object>();
      ComposeRebase r;
      JS_ASSERT(o.Get("vPid").IsObject(), TypeError,
                "compose rebase: `vPid` {l, r} required", env.Undefined());
      auto vPid = o.Get("vPid").As<Napi::Object>();
      parseXY(vPid.Get("l"), r.vPidLx, r.vPidLy);
      parseXY(vPid.Get("r"), r.vPidRx, r.vPidRy);
      const bool ff =
          o.Has("feedForward") && o.Get("feedForward").ToBoolean().Value();
      r.feedForward = ff;
      if (ff) {
        JS_ASSERT(o.Get("pMeas").IsObject(), TypeError,
                  "compose rebase: `pMeas` {x, y} required with feedForward",
                  env.Undefined());
        parseXY(o.Get("pMeas"), r.pMeasX, r.pMeasY);
        r.jL = parseJ(o.Get("jL"), "jL");
        r.jR = parseJ(o.Get("jR"), "jR");
      }
      core()->rebase(r);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(probe) {
    auto env = info.Env();
    try {
      return Arv::meterSnapshotToJs(env, core()->probe());
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(pred_in) {
    auto env = info.Env();
    try {
      if (predIn_.IsEmpty()) {
        auto stream = core();
        auto port = PortPipe::makeInPort<ImmResult::Ptr>(
            stream->name(), "pred", "prediction",
            [stream](const ImmResult::Ptr &p) { stream->ingestPrediction(p); });
        auto js = PortPipe::createInPortJs(env, port);
        predIn_ = Napi::Persistent(js.As<Napi::Object>());
      }
      return predIn_.Value();
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(volt_out) {
    auto env = info.Env();
    try {
      if (voltOut_.IsEmpty()) {
        auto stream = core();
        auto port = PortPipe::makeOutPort<VoltPair::Ptr>(
            stream->name(), "volt", "volts", stream, stream.get());
        auto js = PortPipe::createOutPortJs(env, port);
        voltOut_ = Napi::Persistent(js.As<Napi::Object>());
      }
      return voltOut_.Value();
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(asyncIterator) {
    auto env = info.Env();
    try {
      auto stream = core().get();
      auto queue = Sub::Queue<VoltPair::Ptr>::create(stream);
      Napi::Value it =
          Sub::Iterator<Sub::Queue<VoltPair::Ptr>>::Create(env, queue);
      if (it.IsObject())
        it.As<Napi::Object>().Set("upstream", info.This());
      return it;
    }
    JS_EXCEPT(env.Undefined())
  }

private:
  Napi::ObjectReference predIn_;
  Napi::ObjectReference voltOut_;
};

CORE_OBJECT(ComposeObject)

// Factory: createComposeStream({ name, initial: {l:{x,y}, r:{x,y}},
//   staleAfterMs?, maxDeltaV? }) — the two optional guards default per the
//   constants above (see kDefaultStaleAfterMs / kDefaultMaxDeltaV); a
//   non-positive value disables the respective guard (tests).
static FN(createComposeStream) {
  auto env = info.Env();
  try {
    std::string streamName = "compose";
    VoltPair initial;
    double staleAfterMs = kDefaultStaleAfterMs;
    double maxDeltaV = kDefaultMaxDeltaV;
    if (info.Length() >= 1 && info[0].IsObject()) {
      auto o = info[0].As<Napi::Object>();
      if (o.Has("name") && o.Get("name").IsString())
        streamName = o.Get("name").As<Napi::String>().Utf8Value();
      if (o.Has("initial") && o.Get("initial").IsObject()) {
        auto i = o.Get("initial").As<Napi::Object>();
        parseXY(i.Get("l"), initial.lx, initial.ly);
        parseXY(i.Get("r"), initial.rx, initial.ry);
      }
      if (o.Has("staleAfterMs") && o.Get("staleAfterMs").IsNumber())
        staleAfterMs = o.Get("staleAfterMs").ToNumber().DoubleValue();
      if (o.Has("maxDeltaV") && o.Get("maxDeltaV").IsNumber())
        maxDeltaV = o.Get("maxDeltaV").ToNumber().DoubleValue();
    }
    auto stream = ComposeStream::create(std::move(streamName), initial,
                                        staleAfterMs, maxDeltaV);
    return ComposeObject::Create(env, stream);
  }
  JS_EXCEPT(env.Undefined())
}

// =====================================================================
// TEST hook (core/test/45): a push-driven ImmResult source with a predict_out
// port — drives the compose brick's pred_in with EXACT synthetic predictions
// (the createTestTrackSource precedent; inert in production).
// =====================================================================
class PredictionPushStream : public ::Stream<ImmResult::Ptr> {
public:
  using Ptr = std::shared_ptr<PredictionPushStream>;
  static Ptr create(std::string nodeId) {
    return std::make_shared<PredictionPushStream>(std::move(nodeId));
  }
  explicit PredictionPushStream(std::string nodeId)
      : nodeId_(std::move(nodeId)) {}
  ~PredictionPushStream() {
    fifo_.close();
    shutdown();
  }
  const std::string &nodeId() const { return nodeId_; }
  void push(const ImmResult::Ptr &p) {
    ImmResult::Ptr copy = p;
    fifo_.write(copy);
  }

protected:
  void start() override {}
  void stop() override {}
  ImmResult::Ptr iterate() override {
    try {
      return fifo_.read();
    } catch (Threading::EOS &) {
      throw StopIteration();
    }
  }

private:
  const std::string nodeId_;
  Threading::FIFO<ImmResult::Ptr> fifo_; // unbounded (test cadence)
};

class TestPredictionSourceObject
    : public CoreObject<TestPredictionSourceObject, PredictionPushStream::Ptr> {
public:
  static inline const std::string name = "TestPredictionSource";
  static std::string describe(const TestPredictionSourceObject *) {
    return "TestPredictionSource";
  }

  static Napi::Function Init(Napi::Env env) {
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(TestPredictionSourceObject, env),
            INSTANCE_METHOD(TestPredictionSourceObject, push),
            Napi::InstanceWrap<TestPredictionSourceObject>::
                template InstanceAccessor<
                    &TestPredictionSourceObject::get_predict_out>(
                    "predict_out", napi_enumerable),
        });
  }

  CORE_OBJECT_DECL(TestPredictionSourceObject)

  TestPredictionSourceObject(const Napi::CallbackInfo &info)
      : CoreObject(info) {}

  FN(push) {
    auto env = info.Env();
    try {
      auto o = info[0].As<Napi::Object>();
      auto p = ImmResult::create();
      p->found = o.Has("found") && o.Get("found").ToBoolean().Value();
      const auto center = o.Get("center");
      if (center.IsObject()) {
        p->hasCenter = true;
        double x, y;
        parseXY(center, x, y);
        p->cx = x;
        p->cy = y;
      }
      if (o.Has("seq"))
        p->seq = static_cast<uint64_t>(o.Get("seq").ToNumber().DoubleValue());
      // Freshness stamp: default = NOW (a live prediction, like the real imm
      // brick's ingest anchor). Tests drive the compose staleness gate with
      // `ageMs` (result measured that long AGO — positive = past).
      p->measuredAtNs = composeNowNs();
      if (o.Has("ageMs") && o.Get("ageMs").IsNumber())
        p->measuredAtNs -= static_cast<int64_t>(
            o.Get("ageMs").ToNumber().DoubleValue() * 1e6);
      core()->push(p);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(predict_out) {
    auto env = info.Env();
    try {
      if (predictOut_.IsEmpty()) {
        auto stream = core();
        auto port = PortPipe::makeOutPort<ImmResult::Ptr>(
            stream->nodeId(), "predict", "prediction", stream, stream.get());
        auto js = PortPipe::createOutPortJs(env, port);
        predictOut_ = Napi::Persistent(js.As<Napi::Object>());
      }
      return predictOut_.Value();
    }
    JS_EXCEPT(env.Undefined())
  }

private:
  Napi::ObjectReference predictOut_;
};

CORE_OBJECT(TestPredictionSourceObject)

static FN(createTestPredictionSource) {
  auto env = info.Env();
  try {
    const auto nodeId = info[0].As<Napi::String>().Utf8Value();
    auto stream = PredictionPushStream::create(nodeId);
    return TestPredictionSourceObject::Create(env, stream);
  }
  JS_EXCEPT(env.Undefined())
}

// Joined into the Tracker namespace from Tracker.cpp's exportTrackerNamespace
// (like the imm brick — the compose brick is its prediction-pipeline companion).
#define EXPORT(OBJ, F) OBJ.Set(#F, Function::New<F>(env, #F));
void exportComposeNamespace(Napi::Env env, Napi::Object &exports) {
  ComposeObject::Export(env, exports);
  TestPredictionSourceObject::Export(env, exports);
  EXPORT(exports, createComposeStream);
  EXPORT(exports, createTestPredictionSource);
}
#undef EXPORT
