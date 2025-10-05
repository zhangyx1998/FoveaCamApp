// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once
#include <exception>

#define EXPECT_END_OF_STREAM                                                   \
  catch (Threading::EOS &) {                                                   \
    /* Normal termination */                                                   \
  }

namespace Threading {

class EOS : public std::exception {};
class Timeout : public std::exception {};

} // namespace Threading
