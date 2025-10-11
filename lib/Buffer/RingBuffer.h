// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once
#include <cstddef>
#include <vector>

#include "Buffer.h"

template <typename V> class SwapRingBuffer;

template <typename V> class RingBuffer {
private:
  friend class SwapRingBuffer<V>;
  Buffer<V> buffer;
  size_t head = 0, tail = 0;

public:
  RingBuffer(Buffer<V> buffer) : buffer(buffer) {}
  RingBuffer(Buffer<V> buffer, size_t head) : RingBuffer(buffer, head, head) {}
  RingBuffer(Buffer<V> buffer, size_t head, size_t tail)
      : buffer(buffer), head(head % buffer.size), tail(tail % buffer.size) {}
  size_t length() const { return (head + buffer.size - tail) % buffer.size; }
  bool isEmpty() const { return head == tail; }
  bool isFull() const { return (head + 1) % buffer.size == tail; }

  V &operator[](size_t index) const {
    if (index >= length())
      CRASH(out_of_range, "RingBuffer::View index out of range");
    return buffer[(tail + index) % buffer.size];
  }

  bool push(const V &value) {
    if (isFull())
      return false;
    buffer[head] = value;
    head = (head + 1) % buffer.size;
    return true;
  }

  size_t push(const V *values, size_t n) {
    size_t pushed = 0;
    for (size_t i = 0; i < n; i++) {
      if (!push(values[i]))
        break;
      pushed++;
    }
    return pushed;
  }

  size_t push(const std::vector<V> &values) {
    return push(values.data(), values.size());
  }

  V pop() {
    if (isEmpty())
      CRASH(out_of_range, "RingBuffer is empty");
    V value = buffer[tail];
    tail = (tail + 1) % buffer.size;
    return value;
  }

  size_t pop(size_t n, V *dst) {
    if (n > length())
      n = length();
    auto count = buffer.copyTo(dst, n, tail);
    tail = (tail + count) % buffer.size;
    if (count < n) {
      // Loop around
      auto remainder = n - count;
      buffer.copyTo(dst + count, remainder, tail);
      tail += remainder;
    }
    return n;
  }

  std::vector<V> pop(size_t n) {
    if (n > length())
      n = length();
    std::vector<V> result(n);
    auto count = pop(n, result.data());
    result.resize(count);
    return std::move(result);
  }

  void clear() { head = tail = 0; }
};

/**
 * @brief
 *
 * @tparam V
 * @tparam N
 */
template <typename V> class SwapRingBuffer {
  // Double dual-pointer structure.
  // One region is read-only (for consumer);
  // The other is write-only (for new data);
  // Once write finished, swap the two regions atomically.
private:
  RingBuffer<V> readable, writable;

public:
  SwapRingBuffer(Buffer<V> &buffer)
      : readable(buffer), writable(buffer, buffer.tail) {};
};
