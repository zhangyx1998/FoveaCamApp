#include <iostream>
#include <sstream>

#include <utils/ref-count.h>

#include "Camera.h"
#include "Error.h"
#include "utils/debug.h"

namespace Arv {

static RefCount::Map<std::string, Camera> registry;

std::vector<Camera::Ptr> Camera::list() {
  arv_update_device_list();
  auto count = arv_get_n_devices();
  std::vector<Camera::Ptr> cameras;
  cameras.reserve(count);
  for (unsigned int i = 0; i < count; i++) {
    auto id = arv_get_device_id(i);
    try {
      cameras.push_back(registry.get(id));
    } catch (const Error &e) {
      WARN("Could not connect to camera %u (%s): %s", i, id, e.what());
    }
  }
  return cameras;
}

ArvCamera *checkCamera(ArvCamera *cam) {
  if (!ARV_IS_CAMERA(cam)) {
    g_clear_object(&cam);
    throw Error("Failed to create camera object");
  }
  return cam;
}

inline ArvCamera *initCamera(std::string id) {
  ArvCamera *cam = arv_camera_new(id.c_str(), nullptr);
  Error::check("arv_camera_new");
  return checkCamera(cam);
}

static inline std::string getTag(Camera *camera) {
  std::stringstream ss;
  try {
    ss << camera->get_vendor() << " " << camera->get_model() << " #"
       << camera->get_serial();
  } catch (...) {
    ss << "(ERROR)";
  }
  return ss.str();
}

Camera::Camera(std::string id)
    : Object(initCamera(id)), id(id), tag(getTag(this)) {}

Frame::Ptr Camera::grab(uint64_t timeout) const {
  auto buffer = arv_camera_acquisition(get(), timeout, &Error::error);
  Error::check("arv_camera_acquisition");
  if (!ARV_IS_BUFFER(buffer)) {
    g_clear_object(&buffer);
    throw Error("Failed to acquire buffer");
  }
  auto frame = Frame::create(buffer);
  /* Destroy the buffer */
  g_clear_object(&buffer);
  return frame;
}

} // namespace Arv
