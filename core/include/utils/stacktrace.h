// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <sstream>
#include <string>

#define STACKTRACE_ENABLED 1
#if __has_include(<stacktrace>) && defined(__cpp_lib_stacktrace)
#include <stacktrace>
#define HAVE_STD_STACKTRACE 1
#elif defined(__unix__) || defined(__APPLE__)
#include <execinfo.h> // POSIX backtrace
#define HAVE_STD_STACKTRACE 0
#else
#define STACKTRACE_ENABLED 0
#endif

namespace Stacktrace {

inline std::string capture() {
  std::stringstream out;
#if HAVE_STD_STACKTRACE
  auto st = std::stacktrace::current();
  for (auto f : st) {
    out << f.description() << " @ " << f.source_file() << ":" << f.source_line()
        << std::endl;
  }
  return out.str();
#elif STACKTRACE_ENABLED
  void *addrs[128];
  int n = ::backtrace(addrs, 128);
  char **syms = ::backtrace_symbols(addrs, n);
  for (int i = 0; i < n; i++) {
    out << syms[i] << std::endl;
  }
  free(syms);
  return out.str();
#else
  return "(Stacktrace not supported on this platform)";
#endif
}

} // namespace Stacktrace
