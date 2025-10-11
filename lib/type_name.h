// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once
#include <string>
#include <string_view>

template <typename T> constexpr std::string type_name() {
#if defined(__clang__)
  std::string_view name = __PRETTY_FUNCTION__;
  std::string_view prefix = "std::string type_name() [T = ";
  std::string_view suffix = "]";
#elif defined(__GNUC__)
  std::string_view name = __PRETTY_FUNCTION__;
  std::string_view prefix = "constexpr std::string type_name() [with T = ";
  std::string_view suffix = "]";
#elif defined(_MSC_VER)
  std::string_view name = __FUNCSIG__;
  std::string_view prefix = "std::string __cdecl type_name<";
  std::string_view suffix = ">(void)";
#endif
  name.remove_prefix(prefix.size());
  name.remove_suffix(suffix.size());
  return std::string(name);
}
