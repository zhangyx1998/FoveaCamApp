#pragma once
#include <cstdint>
#include <string>

template <typename DST, typename SRC> DST convert(const SRC &src);

template <> inline std::string convert(const char *const &src) {
  return src ? std::string(src) : std::string();
}

template <> inline const char *convert(const std::string &src) {
  return src.c_str();
}

template <uintptr_t, typename T> inline uintptr_t convert(const T *src) {
  return reinterpret_cast<uintptr_t>(src);
}

#define CASE_ENUM_TO_STRING(VAL, NAME, ...)                                    \
  if (VAL == __VA_OPT__(__VA_ARGS__)##NAME)                                    \
    return #NAME;

#define CASE_STRING_TO_ENUM(VAL, NAME, ...)                                    \
  if (VAL == #NAME)                                                            \
    return __VA_OPT__(__VA_ARGS__)##NAME;
