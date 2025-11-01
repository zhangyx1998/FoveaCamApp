// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "utils/stacktrace.h"
#include <pointer.h>

class TracedError : public std::exception, public Shared<TracedError> {
public:
  const char *what() const noexcept override { return full_message.c_str(); }
  const std::string message;
  const std::string stack;
  const std::string full_message;
  TracedError(const std::string message)
      : message(message), stack(Stacktrace::capture()),
        full_message(message + "\n" + stack) {}
  TracedError(const std::exception &e) : TracedError(e.what()) {}
};

class AssertionError : public TracedError {
public:
  // Inherit the constructors from TracedError
  using TracedError::TracedError;
};

#define ASSERT(COND, MESSAGE)                                                  \
  {                                                                            \
    if (!(COND)) {                                                             \
      throw AssertionError(std::string(MESSAGE));                              \
    }                                                                          \
  }
