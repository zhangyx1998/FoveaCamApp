// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once
#include <cstddef>
#include <vector>

#include "Buffer.h"
#include "crash.h"

template <typename V> class VectorBuffer {
private:
  Buffer<V> buffer;
  size_t len = 0;

public:
  VectorBuffer(Buffer<V> buffer) : buffer(buffer) {}
  VectorBuffer(Buffer<V> buffer, size_t len) : buffer(buffer), len(len) {}
  const size_t &length() const { return len; }
  bool isEmpty() const { return len == 0; }
  bool isFull() const { return len == buffer.size; }

  V &operator[](size_t index) const {
    if (index >= len)
      CRASH(out_of_range, "VectorBuffer::View index out of range");
    return buffer[index];
  }

  bool push(const V &value) {
    if (isFull())
      return false;
    buffer[len] = value;
    len++;
    return true;
  }

  size_t push(const V *values, size_t n) {
    auto count = buffer.copyFrom(values, n, len);
    len += count;
    return count;
  }

  size_t push(const std::vector<V> &values) {
    return push(values.data(), values.size());
  }

  V pop() {
    if (isEmpty())
      CRASH(out_of_range, "VectorBuffer is empty");
    V value = buffer[--len];
    return value;
  }

  size_t pop(size_t n, V *dst) {
    if (n > len)
      n = len;
    auto count = buffer.copyTo(dst, n, len - n);
    len -= count;
    return count;
  }

  std::vector<V> pop(size_t n) {
    if (n > len)
      n = len;
    std::vector<V> result(n);
    auto count = pop(n, result.data());
    result.resize(count);
    return result;
  }

  void clear() { len = 0; }
};
