// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <chrono>
#include <cstdlib>
#include <unistd.h>
#include <vector>

#include "debug.h"

static const auto PROGRAM_START_TIME = std::chrono::steady_clock::now();

std::string DEBUG_NOW() {
  const auto millis = std::chrono::duration<double, std::milli>(
                          std::chrono::steady_clock::now() - PROGRAM_START_TIME)
                          .count();
  const auto minutes = int(millis / 60000);
  const auto seconds = (millis - minutes * 60000) / 1000;
  // MM:SS.mmm
  char buffer[16];
  std::snprintf(buffer, sizeof(buffer), "%02d:%06.3f", minutes, seconds);
  return TermColor::C(std::string(buffer),
                      {TermColor::DIM, TermColor::UNDERLINE}, STDERR_FILENO);
}

#if defined(DEBUG)

static class VerboseTargets {
  bool enabled = false;
  std::vector<std::string> includes;
  std::vector<std::string> excludes;

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
      if (!trimmed.empty()) {
        if (trimmed[0] == '!')
          excludes.push_back(trimmed.substr(1));
        else
          includes.push_back(trimmed);
      }
    }
  }
  bool match(const char *filename) const {
    if (!enabled)
      return false;
    std::string target(filename);
    bool included = false, excluded = false;
    if (includes.empty())
      included = true;
    else {
      for (const auto &pattern : includes)
        if (target == pattern) {
          included = true;
          break;
        }
    }
    if (!included)
      return false;
    for (const auto &pattern : excludes) {
      if (target == pattern)
        return false;
    }
    return true;
  }
} const targets;

bool VERBOSE_MATCH(const char *filename) { return targets.match(filename); }

#endif
