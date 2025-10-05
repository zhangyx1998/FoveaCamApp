// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#if defined(DEBUG)
#include <cstdio>

#include "string.h"

// 1. Match all
//   - `VERBOSE=` or `VERBOSE=*`
// 2. Match certain files
//   - `VERBOSE=foo.cpp,bar.cpp`
bool VERBOSE_MATCH(const char *filename);

#define VERBOSE(TEMPLATE, ...)                                                 \
  if (VERBOSE_MATCH(FILENAME_NO_SUFFIX.c_str())) {                             \
    std::fprintf(stderr, "VERBOSE [%s]: " TEMPLATE "\n",                       \
                 FILENAME_NO_SUFFIX.c_str() __VA_OPT__(, ) __VA_ARGS__);       \
  }
#else
#define VERBOSE(TEMPLATE, ...)
#endif
