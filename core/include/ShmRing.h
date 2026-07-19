// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <memory>
#include <string>
#include <vector>

#include <napi.h>

#include "ShmLayout.h" // dependency-free segment layout (constants + PODs)

namespace ShmRing {

struct WriteTarget {
  void *data = nullptr;
  size_t bytes = 0;
  std::vector<int> shape;
  int channels = 0;
  std::shared_ptr<void> keepAlive;
};

bool isSlot(const Napi::Value &value);
WriteTarget writeTarget(const Napi::Value &value);
void exportShmNamespace(Napi::Env env, Napi::Object &exports);

} // namespace ShmRing
