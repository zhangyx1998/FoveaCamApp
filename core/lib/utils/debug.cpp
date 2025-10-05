// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstdlib>
#include <vector>

#include "debug.h"

#include "string.h"

#if defined(DEBUG)

static class VerboseTargets {
  bool enabled = false;
  std::vector<std::string> targets;

public:
  VerboseTargets() {
    const char *env = std::getenv("VERBOSE");
    if (!env)
      return;
    enabled = true;
    const std::string pattern(env);
    if (pattern.empty() || pattern == "*")
      return;
    size_t start = 0;
    while (start < pattern.size()) {
      size_t end = pattern.find(',', start);
      std::string token;
      if (end == std::string::npos) {
        token = pattern.substr(start);
        start = pattern.size();
      } else {
        token = pattern.substr(start, end - start);
        start = end + 1;
      }
      auto trimmed = trim(token);
      if (!trimmed.empty())
        targets.push_back(trimmed);
    }
  }
  bool match(const char *filename) {
    if (!enabled)
      return false;
    if (targets.empty())
      return true;
    std::string target(filename);
    for (const auto &pattern : targets)
      if (target == pattern)
        return true;
    return false;
  }
} TARGETS;

bool VERBOSE_MATCH(const char *filename) { return TARGETS.match(filename); }

#endif
