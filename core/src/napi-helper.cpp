// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include "napi-helper.h"

static std::string objectKey(const Napi::Value &key) {
  if (key.IsNumber())
    return repr(key);
  if (!key.IsString())
    return "[" + repr(key) + "]";
  const auto str = key.As<Napi::String>().Utf8Value();
  // Check if str is a valid identifier
  if (!str.empty() && (std::isalpha(str[0]) || str[0] == '_' || str[0] == '$'))
    return str;
  // Escape quotes and backslashes
  std::string escaped;
  for (char c : str) {
    if (c == '\\' || c == '"')
      escaped += '\\';
    escaped += c;
  }
  return "\"" + escaped + "\"";
}

static std::string repr(const Napi::Object &obj, int max_depth,
                        int current_depth, bool omit_empty = false) {
  const auto is_array = obj.IsArray();
  const std::string brace_l = is_array ? "[" : "{",
                    brace_r = is_array ? "]" : "}";
  auto props = obj.GetPropertyNames();
  uint32_t length = props.Length();
  if (length == 0)
    return omit_empty ? "" : brace_l + brace_r;
  if (current_depth >= max_depth)
    return brace_l + " ... " + brace_r;
  std::ostringstream oss;
  oss << brace_l << " ";
  for (uint32_t i = 0; i < length; i++) {
    if (i != 0)
      oss << ", ";
    auto key = props.Get(i);
    auto value = obj.Get(key);
    oss << " " << objectKey(key) << ": "
        << repr(value, max_depth, current_depth + 1);
  }
  oss << " " << brace_r;
  return oss.str();
}

std::string repr(const Napi::Value &value, int max_depth, int current_depth) {
  if (value.IsUndefined()) {
    return "undefined";
  } else if (value.IsNull()) {
    return "null";
  } else if (value.IsBoolean()) {
    return value.As<Napi::Boolean>().Value() ? "true" : "false";
  } else if (value.IsNumber()) {
    double num = value.As<Napi::Number>().DoubleValue();
    // Check for special values
    if (std::isnan(num))
      return "NaN";
    if (std::isinf(num))
      return num > 0 ? "Infinity" : "-Infinity";
    // Strip trailing .0 for integers
    if (num == static_cast<int64_t>(num))
      return std::to_string(static_cast<int64_t>(num));
    else
      return std::to_string(num);
  } else if (value.IsString()) {
    return value.As<Napi::String>().Utf8Value();
  } else if (value.IsBigInt()) {
    bool lossless;
    int64_t bigintValue = value.As<Napi::BigInt>().Int64Value(&lossless);
    return std::to_string(bigintValue) + "n";
  } else if (value.IsSymbol()) {
    return "Symbol()";
  }
  if (!value.IsObject())
    return "[Unknown]";
  std::string tag;
  if (value.IsFunction()) {
    auto func = value.As<Napi::Function>();
    auto name = func.Get("name");
    if (name.IsString() && !name.As<Napi::String>().Utf8Value().empty())
      tag = "[Function: " + name.As<Napi::String>().Utf8Value() + "]";
    else
      tag = "[Function (anonymous)]";
  } else {
    // Try to get the constructor name
    auto obj = value.As<Napi::Object>();
    auto constructor = obj.Get("constructor");
    if (constructor.IsFunction() &&
        constructor != Napi::Object::New(value.Env()).Get("constructor") &&
        constructor != Napi::Array::New(value.Env()).Get("constructor")) {
      auto ctorFunc = constructor.As<Napi::Function>();
      auto name = ctorFunc.Get("name");
      if (name.IsString() && !name.As<Napi::String>().Utf8Value().empty())
        tag = "[" + name.As<Napi::String>().Utf8Value() + "]";
    }
  };
  std::vector<std::string> segments;
  auto content =
      repr(value.As<Napi::Object>(), max_depth, current_depth, !tag.empty());
  if (!tag.empty())
    segments.push_back(tag);
  if (!content.empty())
    segments.push_back(content);
  return join(segments, " ");
}
