// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <sstream>
#include <string>
#include <unistd.h>
#include <vector>

#include "string.h"

std::string DEBUG_NOW();

static constexpr const char *COLOR = "\033[33m"; // Yellow

namespace TermColor {
static constexpr const char *RESET = "\033[0m";
static constexpr const char *BOLD = "\033[1m";
static constexpr const char *DIM = "\033[2m";
static constexpr const char *BLACK = "\033[30m";
static constexpr const char *RED = "\033[31m";
static constexpr const char *GREEN = "\033[32m";
static constexpr const char *YELLOW = "\033[33m";
static constexpr const char *BLUE = "\033[34m";
static constexpr const char *MAGENTA = "\033[35m";
static constexpr const char *CYAN = "\033[36m";
static constexpr const char *WHITE = "\033[37m";
static constexpr const char *GRAY = "\033[90m";
static constexpr const char *UNDERLINE = "\033[4m";
static constexpr const char *REVERSED = "\033[7m";
static constexpr const char *CLEAR_LINE = "\033[2K";
static constexpr const char *CLEAR_SCREEN = "\033[2J";

inline const char *C(const char *color, int fd) {
  if (isatty(fd))
    return color;
  else
    return "";
}

inline std::string C(std::string content, std::vector<const char *> colors,
                     int fd = STDOUT_FILENO) {
  if (isatty(fd)) {
    std::stringstream ss;
    for (const auto &color : colors)
      ss << color;
    ss << content << RESET;
    return ss.str();
  } else {
    return std::string(content);
  }
}

} // namespace TermColor

#define __LOG__(TEMPLATE, LEVEL, COLOR, MODULE, ...)                           \
  std::fprintf(stderr, "%s %s[" LEVEL "] [%s]: " TEMPLATE "%s\n",              \
               DEBUG_NOW().c_str(),                                            \
               TermColor::C(TermColor::COLOR, STDERR_FILENO),                  \
               MODULE __VA_OPT__(, ) __VA_ARGS__,                              \
               TermColor::C(TermColor::RESET, STDERR_FILENO))
#define INFO(TEMPLATE, ...)                                                    \
  __LOG__(TEMPLATE, "INFO", WHITE,                                             \
          FILENAME_NO_SUFFIX.c_str() __VA_OPT__(, ) __VA_ARGS__)

#define WARN(TEMPLATE, ...)                                                    \
  __LOG__(TEMPLATE, "WARN", YELLOW,                                            \
          FILENAME_NO_SUFFIX.c_str() __VA_OPT__(, ) __VA_ARGS__)

#define ERROR(TEMPLATE, ...)                                                   \
  __LOG__(TEMPLATE, "ERR ", RED,                                               \
          FILENAME_NO_SUFFIX.c_str() __VA_OPT__(, ) __VA_ARGS__)

#if defined(DEBUG)
#include <chrono>
#include <cstdio>

// 1. Match all
//   - `VERBOSE=` or `VERBOSE=*`
// 2. Match certain files
//   - `VERBOSE=foo.cpp,bar.cpp`
bool VERBOSE_MATCH(const char *filename);

#define VERBOSE(TEMPLATE, ...)                                                 \
  if (VERBOSE_MATCH(FILENAME_NO_SUFFIX.c_str())) {                             \
    __LOG__(TEMPLATE, "VERB", BLUE,                                            \
            FILENAME_NO_SUFFIX.c_str() __VA_OPT__(, ) __VA_ARGS__);            \
  }

class DebugTimer {
  using timepoint = std::chrono::steady_clock::time_point;
  const timepoint t0 = std::chrono::steady_clock::now();
  const char *filename;
  std::string description;

public:
  inline DebugTimer(const char *filename, const std::string &description)
      : filename(filename), description(description) {}
  inline ~DebugTimer() {
    if (!VERBOSE_MATCH(filename) && !VERBOSE_MATCH("TIMER"))
      return;
    const auto t1 = std::chrono::steady_clock::now();
    const auto duration =
        std::chrono::duration<double, std::milli>(t1 - t0).count();
    std::fprintf(stderr, "[%s] [%s]: %s took %.3f ms\n", DEBUG_NOW().c_str(),
                 filename, description.c_str(), duration);
  }
};

#define VERBOSE_TIMER(DESC)                                                    \
  DebugTimer debug_timer(FILENAME_NO_SUFFIX.c_str(), DESC);
#else
#define VERBOSE(TEMPLATE, ...)
#define VERBOSE_TIMER(DESC)
#endif
