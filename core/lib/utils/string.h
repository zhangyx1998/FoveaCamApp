// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <cstdio>
#include <cstdlib>
#include <string>

// Constexpr function to extract just the filename from a full path
#if defined(__APPLE__) || defined(__linux__)
// On Unix-like systems, __FILE__ is usually a full path
constexpr const char *extract_filename(const char *path) {
  const char *file = path;
  while (*path) {
    if (*path++ == '/') {
      file = path;
    }
  }
  return file;
}
#elif defined(_WIN32) || defined(_WIN64)
// On Windows, __FILE__ is usually a relative path with backslashes
constexpr const char *extract_filename(const char *path) {
  const char *file = path;
  while (*path) {
    if (*path++ == '\\') {
      file = path;
    }
  }
  return file;
}
#else
// Fallback: return the full path as-is
constexpr const char *extract_filename(const char *path) { return path; }
#endif

constexpr const std::string remove_suffix(const char *filename) {
  const std::string str(filename);
  size_t dot = str.rfind('.');
  if (dot == std::string::npos)
    return str;
  return str.substr(0, dot);
}

#define FILENAME extract_filename(__FILE__)
#define FILENAME_NO_SUFFIX remove_suffix(extract_filename(__FILE__))

// Add helper to trim whitespace
static inline std::string trim(const std::string &str,
                               const std::string whitespace = " \t\n\r") {
  size_t first = str.find_first_not_of(whitespace);
  if (first == std::string::npos)
    return "";
  size_t last = str.find_last_not_of(whitespace);
  return str.substr(first, last - first + 1);
}
