// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <arv.h>

#include "Error.h"
#include "Stream.h"

namespace Arv {

static constexpr guint64 BUFFER_POP_TIMEOUT_US = 100000;

static const Camera *index(const Camera::Ptr &key) { return key.get(); }

// Global registry to ensure the same camera always maps to the same stream
static RefCount::Map<Camera::Ptr, Stream, &index> registry;

Stream::Ptr Stream::get(Camera::Ptr camera) { return registry.get(camera); }

extern ArvCamera *checkCamera(ArvCamera *cam);
Stream::Stream(const Camera::Ptr &camera) : camera(camera) {
  checkCamera(camera->get());
};

Stream::~Stream() { shutdown(); }

void Stream::start() {
  if (stream != nullptr)
    return;
  stream =
      arv_camera_create_stream(camera->get(), nullptr, nullptr, &Error::error);
  Error::check("arv_camera_create_stream");
  if (!ARV_IS_STREAM(stream)) {
    g_clear_object(&stream);
    throw Error("Failed to create stream object");
  }
  size_t payload = arv_camera_get_payload(camera->get(), &Error::error);
  Error::check("arv_camera_get_payload");
  // 4 buffers, not 2: with only two, the camera has ZERO slack while the
  // consumer copies the popped buffer — any >1-frame-interval hiccup on the
  // stream thread underruns and drops at 60 fps. Buffers return to the pool
  // immediately after the `Frame::create` copy (iterate()), so four is
  // plenty; cost is 2 extra payloads (~8 MB each at 12-bit full-res).
  for (int i = 0; i < 4; i++)
    arv_stream_push_buffer(stream, arv_buffer_new_allocate(payload));
  arv_camera_set_acquisition_mode(
      camera->get(), ARV_ACQUISITION_MODE_CONTINUOUS, &Error::error);
  Error::check("arv_camera_set_acquisition_mode");
  arv_camera_start_acquisition(camera->get(), &Error::error);
  Error::check("arv_camera_start_acquisition");
}

void Stream::stop() {
  if (!stream)
    return;
  arv_camera_stop_acquisition(camera->get(), &Error::error);
  Error::check("arv_camera_stop_acquisition");
  g_clear_object(&stream);
}

Frame::Ptr Stream::iterate() {
  if (!stream)
    throw Error("Stream not started");
  auto buffer = arv_stream_timeout_pop_buffer(stream, BUFFER_POP_TIMEOUT_US);
  if (!buffer)
    return nullptr;
  // Owner-applied dt (unified-time): every frame is stamped with the camera's
  // calibrated clock offset at THIS choke point — atomic read per frame, so a
  // mid-task recalibration swaps cleanly between frames (never torn).
  auto frame = Frame::create(buffer, camera->get_clock_offset_ns());
  arv_stream_push_buffer(stream, buffer);
  return frame;
}

} // namespace Arv
