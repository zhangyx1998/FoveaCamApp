#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <arv.h>

#include <utils/ref-count.h>

#include "Error.h"
#include "Frame.h"
#include "Object.h"

namespace Arv {

template <typename T> struct Range {
  T min;
  T max;
};

class Camera : public Object<ArvCamera, Camera> {
public:
  typedef RefCount::Reference<Camera> Ptr;
  static std::vector<Ptr> list();

public:
  const std::string id;
  // Construct from device ID
  Camera(std::string id);
  // Disallow copy/move
  Camera(const Camera &other) = delete;
  Camera(Camera &&other) = delete;

public:
  const std::string tag;
  Frame::Ptr grab(uint64_t timeout = 0) const;

  inline const std::string &get_physical_id() const { return id; }

#define ARV_CAMERA_FN(type, name, prop)                                        \
  inline type name() const {                                                   \
    auto ret = arv_camera_##prop(get(), &Error::error);                        \
    Error::check("arv_camera_" #prop);                                         \
    return ret;                                                                \
  }

#define ARV_CAMERA_FN_VOID(name, prop)                                         \
  inline void name() const {                                                   \
    arv_camera_##prop(get(), &Error::error);                                   \
    Error::check("arv_camera_" #prop);                                         \
  }

#define ARV_CAMERA_IS(type, name, prop)                                        \
  inline type get_##name() const {                                             \
    auto ret = arv_camera_is_##prop(get(), &Error::error);                     \
    Error::check("arv_camera_is_" #prop);                                      \
    return ret;                                                                \
  }

#define ARV_CAMERA_GET(type, name, prop)                                       \
  inline type get_##name() const {                                             \
    auto ret = arv_camera_get_##prop(get(), &Error::error);                    \
    Error::check("arv_camera_get_" #prop);                                     \
    return ret;                                                                \
  }

#define ARV_CAMERA_SET(type, name, prop)                                       \
  inline void set_##name(type value) const {                                   \
    arv_camera_set_##prop(get(), value, &Error::error);                        \
    Error::check("arv_camera_set_" #prop);                                     \
  }

#define ARV_CAMERA_BOUNDS(type, name, prop)                                    \
  inline Range<type> get_##name##_range() const {                              \
    Range<type> range;                                                         \
    arv_camera_get_##prop##_bounds(get(), &range.min, &range.max,              \
                                   &Error::error);                             \
    Error::check("arv_camera_get_" #prop "_bounds");                           \
    return range;                                                              \
  }

#define ARV_CAMERA_DUP(name, prop)                                             \
  inline std::vector<std::string> get_##name() const {                         \
    unsigned int count;                                                        \
    const char **list =                                                        \
        arv_camera_dup_available_##prop(get(), &count, &Error::error);         \
    Error::check("arv_camera_dup_available_" #prop);                           \
    std::vector<std::string> ret;                                              \
    if (list) {                                                                \
      ret.reserve(count);                                                      \
      for (size_t i = 0; i < count; ++i) {                                     \
        ret.emplace_back(list[i]);                                             \
      }                                                                        \
      g_free(list);                                                            \
    }                                                                          \
    return ret;                                                                \
  }

  /* Device information */
  ARV_CAMERA_GET(const char *, device_id, device_id);
  ARV_CAMERA_GET(const char *, vendor, vendor_name);
  ARV_CAMERA_GET(const char *, model, model_name);
  ARV_CAMERA_GET(const char *, serial, device_serial_number);
  ARV_CAMERA_GET(ArvPixelFormat, pixel_format, pixel_format);
  ARV_CAMERA_SET(ArvPixelFormat, pixel_format, pixel_format);
  inline std::vector<std::string> get_pixel_format_options() const {
    unsigned int count;
    const char **list =
        arv_camera_dup_available_pixel_formats_as_strings(get(), &count,
                                                          &Error::error);
    Error::check("arv_camera_dup_available_pixel_formats_as_strings");
    std::vector<std::string> ret;
    if (list) {
      ret.reserve(count);
      for (size_t i = 0; i < count; ++i) {
        try {
          const auto format = convert<PixelFormat>(std::string(list[i]));
          if (canViewAs(format, BGRA8))
            ret.emplace_back(convert<std::string>(format));
        } catch (const UnknownPixelFormat &) {
          // Keep selection limited to formats the Frame preview path supports.
        }
      }
      g_free(list);
    }
    return ret;
  }

  /* Acquisition control */

  ARV_CAMERA_GET(ArvAcquisitionMode, acquisition_mode, acquisition_mode);
  ARV_CAMERA_SET(ArvAcquisitionMode, acquisition_mode, acquisition_mode);

  ARV_CAMERA_GET(int64_t, frame_count, frame_count);
  ARV_CAMERA_SET(int64_t, frame_count, frame_count);
  ARV_CAMERA_BOUNDS(int64_t, frame_count, frame_count);

  ARV_CAMERA_GET(bool, frame_rate_enable, frame_rate_enable);
  ARV_CAMERA_SET(bool, frame_rate_enable, frame_rate_enable);
  inline bool get_frame_rate_available() const {
    auto ret = arv_camera_is_frame_rate_available(get(), &Error::error);
    Error::check("arv_camera_is_frame_rate_available");
    return ret;
  }

  ARV_CAMERA_GET(double, frame_rate, frame_rate);
  ARV_CAMERA_SET(double, frame_rate, frame_rate);
  ARV_CAMERA_BOUNDS(double, frame_rate, frame_rate);

  ARV_CAMERA_SET(const char *, trigger, trigger);
  ARV_CAMERA_DUP(trigger_options, triggers);

  ARV_CAMERA_FN_VOID(clear_triggers, clear_triggers);
  ARV_CAMERA_FN_VOID(software_trigger, software_trigger);

  ARV_CAMERA_SET(const char *, trigger_source, trigger_source);
  ARV_CAMERA_GET(const char *, trigger_source, trigger_source);
  ARV_CAMERA_DUP(trigger_source_options, trigger_sources);

  /* Generic GenICam feature access — for features without a dedicated
   * accessor above, e.g. configuring a strobe/line output as ExposureActive
   * (LineSelector + LineMode + LineSource) for synced capture. See
   * docs/refactor/synced-capture.md §6. */
  inline std::string get_feature(const char *name) const {
    auto ret = arv_camera_get_string(get(), name, &Error::error);
    Error::check("arv_camera_get_string");
    return ret ? std::string(ret) : std::string();
  }
  /* Integer GenICam node access (e.g. Width/Height, which are ArvGcIntegerNode
   * and would fail `arv_camera_get_string`). */
  inline int64_t get_feature_int(const char *name) const {
    auto ret = arv_camera_get_integer(get(), name, &Error::error);
    Error::check("arv_camera_get_integer");
    return ret;
  }
  inline void set_feature(const char *name, const char *value) const {
    arv_camera_set_string(get(), name, value, &Error::error);
    Error::check("arv_camera_set_string");
  }
  inline void execute_feature(const char *name) const {
    arv_camera_execute_command(get(), name, &Error::error);
    Error::check("arv_camera_execute_command");
  }

  ARV_CAMERA_IS(bool, exposure_time_available, exposure_time_available);
  ARV_CAMERA_IS(bool, exposure_auto_available, exposure_auto_available);

  ARV_CAMERA_GET(double, exposure, exposure_time);
  ARV_CAMERA_SET(double, exposure, exposure_time);
  ARV_CAMERA_BOUNDS(double, exposure, exposure_time);

  ARV_CAMERA_GET(ArvAuto, exposure_auto, exposure_time_auto);
  ARV_CAMERA_SET(ArvAuto, exposure_auto, exposure_time_auto);

  ARV_CAMERA_SET(ArvExposureMode, exposure_mode, exposure_mode);

  /* Analog control */

  ARV_CAMERA_IS(bool, gain_available, gain_available);
  ARV_CAMERA_IS(bool, gain_auto_available, gain_auto_available);
  void select_gain(const char *selector) const {
    arv_camera_select_gain(get(), selector, &Error::error);
    Error::check("arv_camera_select_gain");
  }
  ARV_CAMERA_DUP(gain_options, gains);

  ARV_CAMERA_GET(double, gain, gain);
  ARV_CAMERA_SET(double, gain, gain);
  ARV_CAMERA_BOUNDS(double, gain, gain);
  ARV_CAMERA_GET(ArvAuto, gain_auto, gain_auto);
  ARV_CAMERA_SET(ArvAuto, gain_auto, gain_auto);

  ARV_CAMERA_IS(bool, black_level_available, black_level_available);
  ARV_CAMERA_IS(bool, black_level_auto_available, black_level_auto_available);
  void select_black_level(const char *selector) const {
    arv_camera_select_black_level(get(), selector, &Error::error);
    Error::check("arv_camera_select_black_level");
  }
  ARV_CAMERA_DUP(black_level_options, black_levels);

  ARV_CAMERA_GET(double, black_level, black_level);
  ARV_CAMERA_SET(double, black_level, black_level);
  ARV_CAMERA_BOUNDS(double, black_level, black_level);
  ARV_CAMERA_GET(ArvAuto, black_level_auto, black_level_auto);
  ARV_CAMERA_SET(ArvAuto, black_level_auto, black_level_auto);
};

} // namespace Arv
