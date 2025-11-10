// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
#include <exception> // IWYU pragma: keep
#define CRASH(type, ERR) throw std::type(ERR)
#else
// In embedded environments where exceptions are disabled
// An external crash function must be provided to define behavior on errors
// that cannot be recovered from.
#include <string>
void crash(std::string err);
#define CRASH(type, ERR) crash(std::string("[" #type "] " #ERR))
#endif
