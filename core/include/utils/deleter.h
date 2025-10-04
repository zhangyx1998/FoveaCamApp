// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <napi.h>

#include "utils/napi-helper.h"
#include "utils/type-name.h"

template <typename T> void deleter(Napi::Env, void *, void *hint) {
  if (hint) {
    delete static_cast<T *>(hint);
    auto name = type_name<T>();
    VERBOSE("[deleter] Collected: %.*s %p", static_cast<int>(name.size()),
            name.data(), hint);
  } else {
    throw std::runtime_error("Got null deleter hint pointer");
  }
}
