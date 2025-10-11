// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

template <auto NOW(), typename TC = decltype(NOW())> class Time {
private:
  using TA = decltype(NOW());
  mutable TC counter;
  mutable TA anchor;

public:
  inline void update() const {
    auto next_anchor = NOW();
    auto elapsed = next_anchor - anchor;
    anchor = next_anchor;
    counter += elapsed;
  }
  inline TC now() const {
    update();
    return counter;
  }
  inline void reset(TC init = 0) {
    counter = init;
    anchor = NOW();
  }
};
