// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// Generic native PORT/PIPE substrate: bricks expose named TYPED ports as JS
// handles; `outPort.pipe(inPort, opts?)` connects two native C++ threads and
// returns a Link with probe()/release(). Link types: latest / fifo / ring.
// spec: docs/spec/core-port-pipe.md

#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <typeindex>

#include <napi.h>

#include <Stream/Stream.h>
#include <Threading/FIFO.h>
#include <Threading/Leaky.h>
#include <Threading/Ring.h>
#include <utils/thread.h>

namespace PortPipe {

struct LinkOptions {
  enum class Type { Latest, Fifo, Ring };
  Type type = Type::Latest;
  /** fifo depth / ring size (ignored for latest). */
  size_t depth = 8;
};

/** Out-of-loop probe snapshot (the Link.probe() shape). */
struct LinkStats {
  const char *type = "latest";
  size_t capacity = 1;
  uint64_t written = 0;
  uint64_t delivered = 0;
  uint64_t dropped = 0;
  size_t highWater = 0;
  bool open = false;
  // Latest links only: does the channel slot currently pin a payload? True only
  // between a write and its readout.
  // spec: docs/spec/core-port-pipe.md#leaky-retention
  bool held = false;
};

/** The erased link — owns the channel, the producer subscription and the
 *  delivery thread. `release()` is idempotent; the destructor releases. */
class Link {
public:
  using Ptr = std::shared_ptr<Link>;
  virtual ~Link() = default;
  virtual LinkStats stats() const = 0;
  virtual void release() = 0;

  // Edge identity for Topology.report() (immutable after connect).
  std::string fromId, toId, port, tag;
  LinkOptions::Type type = LinkOptions::Type::Latest;
};

/** Erased IN port: a native sink + tag. `sink` is really a
 *  `shared_ptr<std::function<void(const P&)>>` — the OUT side's typed factory
 *  casts it back after the tag + type_index checks pass. `keepAlive` pins the
 *  consumer brick's stream for the life of any link. */
struct InPort {
  using Ptr = std::shared_ptr<InPort>;
  std::string nodeId, name, tag;
  std::type_index payload = std::type_index(typeid(void));
  std::shared_ptr<void> sink;
};

/** Erased OUT port: node identity + tag + the typed connect factory. */
struct OutPort {
  using Ptr = std::shared_ptr<OutPort>;
  std::string nodeId, name, tag;
  std::type_index payload = std::type_index(typeid(void));
  std::function<Link::Ptr(const InPort &, const LinkOptions &)> connect;
};

// ---- link registry (PortPipe.cpp; NAPI thread + link teardown) --------------
void registerLink(Link *link);
void unregisterLink(Link *link);
/** Emit one EDGES-ONLY NodeReport row per live link (Topology.report()). */
void appendLinkReports(Napi::Env env, Napi::Array &rows);

// ---- JS wrapper factories (PortPipe.cpp — the CoreObjects live there) -------
Napi::Value createOutPortJs(Napi::Env env, OutPort::Ptr port);
Napi::Value createInPortJs(Napi::Env env, InPort::Ptr port);

// ---- typed link implementation ----------------------------------------------

template <typename P> class LinkImpl : public Link {
  using Elem = typename P::element_type;
  using Sink = std::function<void(const P &)>;

  // Producer-side subscriber: pushes every item into the channel. A FIFO push
  // BLOCKS when full (backpressure); close() wakes it (EOS), which
  // the Stream fan-out treats as this subscriber's exit — never a crash.
  class Sub : public Subscriber<P> {
  public:
    Sub(::Stream<P> *stream, LinkImpl *link)
        : Subscriber<P>(stream), link_(link) {}
    ~Sub() { this->close(); }

  protected:
    void push(const P &item) override {
      if (!item)
        return;
      link_->written_.fetch_add(1, std::memory_order_relaxed);
      switch (link_->type) {
      case LinkOptions::Type::Latest: {
        P copy = item;
        link_->leaky_->write(copy); // EOS after close → subscriber exits
        break;
      }
      case LinkOptions::Type::Fifo: {
        P copy = item;
        link_->fifo_->write(copy); // blocks when full (backpressure)
        break;
      }
      case LinkOptions::Type::Ring:
        link_->ring_->write(item); // non-blocking, drop-oldest
        break;
      }
    }

  private:
    LinkImpl *link_;
  };

public:
  LinkImpl(::Stream<P> *stream, std::shared_ptr<void> keepProducer,
           InPort::Ptr in, const LinkOptions &opts) {
    type = opts.type;
    keepProducer_ = std::move(keepProducer);
    in_ = std::move(in);
    sink_ = std::static_pointer_cast<Sink>(in_->sink);
    capacity_ = opts.type == LinkOptions::Type::Latest ? 1 : opts.depth;
    switch (opts.type) {
    case LinkOptions::Type::Latest:
      leaky_ = Threading::Leaky<Elem>::create();
      break;
    case LinkOptions::Type::Fifo:
      fifo_ = Threading::FIFO<P>::create(capacity_);
      break;
    case LinkOptions::Type::Ring:
      ring_ = Threading::Ring<P>::create(capacity_);
      break;
    }
    // Subscribe BEFORE the delivery thread starts: a subscription on a
    // terminated stream closes immediately — deliver() then exits at once.
    sub_ = std::make_unique<Sub>(stream, this);
    open_.store(sub_->state.snapshot().isActive(), std::memory_order_release);
    thread_ = std::thread([this] { deliver(); });
  }
  ~LinkImpl() override { release(); }

  LinkStats stats() const override {
    LinkStats s;
    s.written = written_.load(std::memory_order_relaxed);
    s.delivered = delivered_.load(std::memory_order_relaxed);
    s.open = open_.load(std::memory_order_acquire);
    s.capacity = capacity_;
    switch (type) {
    case LinkOptions::Type::Latest:
      s.type = "latest";
      // Latest-wins: anything written but never delivered was superseded.
      s.dropped = s.written > s.delivered ? s.written - s.delivered : 0;
      s.highWater = 1;
      s.held = leaky_->holds(); // lock-free probe
      break;
    case LinkOptions::Type::Fifo:
      s.type = "fifo";
      s.dropped = 0; // lossless by construction
      s.highWater = fifo_->high_water();
      break;
    case LinkOptions::Type::Ring:
      s.type = "ring";
      s.dropped = ring_->drops();
      s.highWater = ring_->high_water();
      break;
    }
    return s;
  }

  void release() override {
    if (released_.exchange(true, std::memory_order_acq_rel))
      return;
    unregisterLink(this); // topology edge retires FIRST (probe-safe)
    open_.store(false, std::memory_order_release);
    // Close the channel BEFORE unsubscribing (close-first discipline).
    // spec: docs/spec/core-port-pipe.md#teardown
    closeChannel();
    sub_.reset(); // Subscriber::close → eject/drain discipline
    if (thread_.joinable())
      thread_.join();
    keepProducer_.reset();
    in_.reset();
  }

private:
  /** Close the channel (idempotent). Shared by release() and EVERY deliver()
   *  exit path — a channel left open on a dead delivery thread deadlocks the
   *  producer (FIFO backpressure inside the stream mutex) or black-holes it
   *  (latest/ring). spec: docs/spec/core-port-pipe.md#teardown */
  void closeChannel() {
    switch (type) {
    case LinkOptions::Type::Latest:
      leaky_->close();
      break;
    case LinkOptions::Type::Fifo:
      fifo_->close();
      break;
    case LinkOptions::Type::Ring:
      ring_->close();
      break;
    }
  }

  void deliver() {
    set_thread_name("port-link"); // ≤15 chars (glibc)
    try {
      switch (type) {
      case LinkOptions::Type::Latest: {
        // `take` moves the slot out; reset after delivery so nothing pins the
        // last payload. spec: docs/spec/core-port-pipe.md#leaky-retention
        P dst = nullptr;
        while (true)
          if (leaky_->take(dst, /*wait=*/true) && dst) {
            delivered_.fetch_add(1, std::memory_order_relaxed);
            (*sink_)(dst);
            dst.reset();
          }
        break;
      }
      case LinkOptions::Type::Fifo:
        while (true) {
          P item = fifo_->read(); // EOS on close
          delivered_.fetch_add(1, std::memory_order_relaxed);
          (*sink_)(item);
        }
        break;
      case LinkOptions::Type::Ring: {
        while (true) {
          P item; // per-iteration scope — released while blocked on read
          if (!ring_->read(item))
            break;
          delivered_.fetch_add(1, std::memory_order_relaxed);
          (*sink_)(item);
        }
        break;
      }
      }
    } catch (Threading::EOS &) {
      // channel closed — normal teardown / producer end
    } catch (...) {
      // a throwing sink must not take the process down (never-gate rule)
    }
    // The delivery thread is exiting — for ANY reason (EOS, throwing sink,
    // ring drain). Close the channel so the producer side ejects instead of
    // blocking/black-holing against a dead consumer (see closeChannel()).
    closeChannel();
    open_.store(false, std::memory_order_release);
  }

  std::shared_ptr<void> keepProducer_;
  InPort::Ptr in_;
  std::shared_ptr<Sink> sink_;
  size_t capacity_ = 1;

  typename Threading::Leaky<Elem>::Ptr leaky_;
  typename Threading::FIFO<P>::Ptr fifo_;
  typename Threading::Ring<P>::Ptr ring_;

  std::unique_ptr<Sub> sub_;
  std::thread thread_;
  std::atomic<uint64_t> written_{0};
  std::atomic<uint64_t> delivered_{0};
  std::atomic<bool> open_{false};
  std::atomic<bool> released_{false};
};

// ---- typed port factories -----------------------------------------------------

/** Build an OUT port over a brick's `Stream<P>`. `keepAlive` pins the brick's
 *  stream (typically the handle/stream shared_ptr) for the life of any link
 *  created from this port. */
template <typename P>
OutPort::Ptr makeOutPort(std::string nodeId, std::string name, std::string tag,
                         std::shared_ptr<void> keepAlive, ::Stream<P> *stream) {
  auto port = std::make_shared<OutPort>();
  port->nodeId = std::move(nodeId);
  port->name = std::move(name);
  port->tag = std::move(tag);
  port->payload = std::type_index(typeid(P));
  auto keep = std::move(keepAlive);
  OutPort *raw = port.get();
  port->connect = [raw, keep, stream](const InPort &in,
                                      const LinkOptions &opts) -> Link::Ptr {
    // The NAPI seam already verified tag + type_index equality.
    auto inCopy = std::make_shared<InPort>(in);
    auto link = std::make_shared<LinkImpl<P>>(stream, keep, inCopy, opts);
    link->fromId = raw->nodeId;
    link->toId = in.nodeId;
    link->port = in.name;
    link->tag = raw->tag;
    link->type = opts.type;
    registerLink(link.get());
    return link;
  };
  return port;
}

/** Build an IN port over a native sink. `sink` runs on the LINK's delivery
 *  thread — it must be internally synchronized (brick ingest mutexes) and
 *  must capture whatever keeps the consumer alive. */
template <typename P>
InPort::Ptr makeInPort(std::string nodeId, std::string name, std::string tag,
                       std::function<void(const P &)> sink) {
  auto port = std::make_shared<InPort>();
  port->nodeId = std::move(nodeId);
  port->name = std::move(name);
  port->tag = std::move(tag);
  port->payload = std::type_index(typeid(P));
  port->sink =
      std::make_shared<std::function<void(const P &)>>(std::move(sink));
  return port;
}

} // namespace PortPipe
