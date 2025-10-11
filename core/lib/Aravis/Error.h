// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <arv.h>
#include <string>

#include <utils/error.h>
namespace Arv {

class Error : public TracedError {
public:
  using TracedError::TracedError;
  Error(std::string message) : TracedError("[Aravis] " + message) {}
  static thread_local GError *error;
  static void check(const char action[] = "");
};

} // namespace Arv
