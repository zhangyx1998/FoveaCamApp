#include "Camera.h"
#include "Error.h"

#include <iostream>
#include <sstream>

namespace Arv {

std::vector<Camera> Camera::list() {
  arv_update_device_list();
  auto count = arv_get_n_devices();
  std::vector<Camera> cameras;
  cameras.reserve(count);
  for (unsigned int i = 0; i < count; i++) {
    const char *device_id = arv_get_device_id(i);
    try {
      cameras.push_back(Camera(device_id));
    } catch (const Error &e) {
      std::cerr << "Warning: Could not connect to camera " << i << " ("
                << device_id << "): " << e.what() << std::endl;
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

inline ArvCamera *initCamera(const char *id) {
  ArvCamera *cam = arv_camera_new(id, nullptr);
  Error::check("arv_camera_new");
  return checkCamera(cam);
}

Camera::Camera(const char *id) : Object(initCamera(id)), physical_id(id) {}

std::string Camera::tag() const {
  std::stringstream ss;
  ss << get_vendor() << " " << get_model() << " #" << get_serial();
  return ss.str();
}

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
