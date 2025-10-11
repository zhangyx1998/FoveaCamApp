// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <Aravis/Frame.h>
#include <Aravis/Stream.h>
#include <Stream/Stream.h>
#include <Threading/Guard.h>
#include <pointer.h>

#include "Dispatcher.h"
#include "napi-helper.h"

using namespace Dispatcher;

class FrameQueue : public Subscriber<Arv::Frame::Ptr>,
                   public Shared<FrameQueue> {
public:
  inline FrameQueue(Napi::Env env, Stream<Arv::Frame::Ptr> *stream)
      : Subscriber<Arv::Frame::Ptr>(stream), env(env) {}

private:
  using Subscriber::Subscriber;
  Napi::Env env;
  // Push-pull data model. Only one of data_queue or future_queue is
  // non-empty at any time.
  typedef struct {
    // Holds incoming data
    std::queue<Arv::Frame::Ptr> data_queue;
    // Holds pending futures
    std::queue<Future::Ptr> future_queue;
  } Data;
  // Guarded access ensures thread safety
  Threading::Guard<Data> data;

  void push(const Arv::Frame::Ptr &value) override;
  void close(bool unsubscribe, TracedError::Ptr err) override;

public:
  FN(next);
  FN(close);
};

// Synchronous iterator that always returns the latest frame
class FrameLatest : public Subscriber<Arv::Frame::Ptr>,
                    public Shared<FrameLatest> {
public:
  inline FrameLatest(Napi::Env env, Stream<Arv::Frame::Ptr> *stream)
      : Subscriber<Arv::Frame::Ptr>(stream), env(env) {}

private:
  using Subscriber::Subscriber;
  Napi::Env env;
  Threading::Guard<Arv::Frame::Ptr> data = {nullptr};
  void push(const Arv::Frame::Ptr &value) override;

public:
  FN(next);
  FN(close);
  GET(current);
};
