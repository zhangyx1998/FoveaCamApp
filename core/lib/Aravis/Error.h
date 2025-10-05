// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <stdexcept>

#include <arv.h>
#include <string>

namespace Arv {

class Error : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
  Error(std::string message) : std::runtime_error("[Aravis] " + message) {}
  static thread_local GError *error;
  static void check(const char action[] = "");
};

} // namespace Arv
