// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <arv.h>

#include "Frame.h"
#include "Stream/Stream.h"
#include <utils/pointer.h>
#include <utils/ref-count.h>

namespace Arv {

class Stream : public ::Stream<Frame::Ptr> {
public:
  typedef RefCount::Reference<Stream> Ptr;
  static Ptr get(ArvCamera *camera);
  Stream(ArvCamera *camera);
  ~Stream();

private:
  ArvCamera *const camera;
  ArvStream *stream = nullptr;
  void start() override;
  void stop() override;
  Frame::Ptr iterate() override;
};

} // namespace Arv
