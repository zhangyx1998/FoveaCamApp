// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstddef>
#include <cstring>

#include <napi.h>

#include <convert.h>
#include <sstream>

#include "napi-helper.h"

static std::string cat(const Napi::CallbackInfo &info) {
  std::stringstream ss;
  for (size_t i = 0; i < info.Length(); ++i) {
    if (i != 0)
      ss << " ";
    ss << repr(info[i]);
  }
  return ss.str();
}

static const char MODULE_NAME[] = "[JavaScript]";

FN(error) {
  const auto env = info.Env();
  try {
    __LOG__("%s", "ERR ", RED, MODULE_NAME, cat(info).c_str());
    return info.Env().Undefined();
  }
  JS_EXCEPT(info.Env().Undefined())
}

FN(warn) {
  const auto env = info.Env();
  try {
    __LOG__("%s", "WARN", YELLOW, MODULE_NAME, cat(info).c_str());
    return info.Env().Undefined();
  }
  JS_EXCEPT(info.Env().Undefined())
}

FN(info) {
  const auto env = info.Env();
  try {
    __LOG__("%s", "INFO", WHITE, MODULE_NAME, cat(info).c_str());
    return info.Env().Undefined();
  }
  JS_EXCEPT(info.Env().Undefined())
}

FN(verbose) {
  const auto env = info.Env();
  try {
    if (VERBOSE_MATCH(MODULE_NAME))
      __LOG__("%s", "VERB", BLUE, MODULE_NAME, cat(info).c_str());
    return info.Env().Undefined();
  }
  JS_EXCEPT(info.Env().Undefined())
}

void exportLogModule(Napi::Env env, Napi::Object &exports) {
  exports.Set("error", Napi::Function::New(env, error, "error"));
  exports.Set("warn", Napi::Function::New(env, warn, "warn"));
  exports.Set("info", Napi::Function::New(env, info, "info"));
  exports.Set("verbose", Napi::Function::New(env, verbose, "verbose"));
}
