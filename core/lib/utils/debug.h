// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#if defined(DEBUG)
#include <chrono>
#include <cstdio>

#include "string.h"

// 1. Match all
//   - `VERBOSE=` or `VERBOSE=*`
// 2. Match certain files
//   - `VERBOSE=foo.cpp,bar.cpp`
bool VERBOSE_MATCH(const char *filename);

std::string VERBOSE_NOW();

#define VERBOSE(TEMPLATE, ...)                                                 \
  if (VERBOSE_MATCH(FILENAME_NO_SUFFIX.c_str())) {                             \
    std::fprintf(stderr, "[%s] [%s]: " TEMPLATE "\n", VERBOSE_NOW().c_str(),   \
                 FILENAME_NO_SUFFIX.c_str() __VA_OPT__(, ) __VA_ARGS__);       \
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
    std::fprintf(stderr, "[%s] [%s]: %s took %.3f ms\n", VERBOSE_NOW().c_str(),
                 filename, description.c_str(), duration);
  }
};

#define VERBOSE_TIMER(DESC)                                                    \
  DebugTimer debug_timer(FILENAME_NO_SUFFIX.c_str(), DESC);
#else
#define VERBOSE(TEMPLATE, ...)
#define VERBOSE_TIMER(DESC)
#endif
