// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <arv.h>

#include "Error.h"
#include "Stream.h"

namespace Arv {

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
  for (int i = 0; i < 2; i++)
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
  auto buffer = arv_stream_pop_buffer(stream);
  if (!buffer)
    return nullptr;
  auto frame = Frame::create(buffer);
  arv_stream_push_buffer(stream, buffer);
  return frame;
}

} // namespace Arv
