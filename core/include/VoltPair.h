// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// A commanded per-eye mirror pose in FINAL volts — the payload of the
// `compose.volt_out → controller.pos_in` native link
// (native-compose-controller.md). Tag "volts".

#include <pointer.h>

struct VoltPair : Shared<VoltPair> {
  double lx = 0, ly = 0; // left eye {x, y} volts
  double rx = 0, ry = 0; // right eye {x, y} volts
};
