// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

#pragma once
#include "crash.h"
#include <cstddef>
#include <cstring>
#include <stdexcept>

/**
 * @brief Base buffer class providing safe access to contiguous memory.
 *
 * @tparam V The type of elements stored in the buffer
 */
template <typename V> class Buffer {
public:
  V *const data;     ///< Pointer to the underlying data
  const size_t size; ///< Maximum number of elements the buffer can hold

  /**
   * @brief Construct a buffer from existing memory.
   *
   * @param data Pointer to the data array
   * @param size Number of elements in the array
   */
  Buffer(V *data, size_t size) : data(data), size(size) {}
  virtual ~Buffer() = default;

  // ==================== Data Access ====================

  /** @brief Access element at index (mutable). Index is not checked */
  V &operator[](size_t index) { return data[index]; }

  /** @brief Access element at index (const). Index is not checked */
  const V &operator[](size_t index) const { return data[index]; }

  V &at(ssize_t index) {
    if (index < 0)
      index += size;
    if (index < 0 || index >= size)
      CRASH(out_of_range, "Buffer index out of range");
    return data[index];
  }

  // ==================== Data Operations ====================

  /**
   * @brief Copy data from source array into the buffer.
   *
   * @param src Source array to copy from
   * @param len Number of elements to copy
   * @param offset Starting position in buffer (default: 0)
   * @return Number of elements actually copied
   */
  size_t copyFrom(const void *src, size_t len, size_t offset = 0) {
    if (offset >= size)
      return 0;
    size_t to_copy = (len > size - offset) ? (size - offset) : len;
    std::memcpy(data + offset, src, to_copy * sizeof(V));
    return to_copy;
  }

  /**
   * @brief Copy data from buffer to destination array.
   *
   * @param dst Destination array to copy to
   * @param len Number of elements to copy
   * @param offset Starting position in buffer (default: 0)
   * @return Number of elements actually copied
   */
  size_t copyTo(void *dst, size_t len, size_t offset = 0) const {
    if (offset >= size)
      return 0;
    size_t to_copy = (len > size - offset) ? (size - offset) : len;
    std::memcpy(dst, data + offset, to_copy * sizeof(V));
    return to_copy;
  }

  using iterator = V *;
  using const_iterator = const V *;
  iterator begin() { return data; }
  iterator end() { return data + size; }
  const_iterator begin() const { return data; }
  const_iterator end() const { return data + size; }
  const_iterator cbegin() const { return data; }
  const_iterator cend() const { return data + size; }

  template <typename S> S &as(bool strict = true) {
    if (strict ? sizeof(S) != size * sizeof(V) : sizeof(S) > size * sizeof(V))
      CRASH(runtime_error, "Buffer::as: Size mismatch");
    return *reinterpret_cast<S *>(data);
  }

  template <typename S> const S &as(bool strict = true) const {
    if (strict ? sizeof(S) != size * sizeof(V) : sizeof(S) > size * sizeof(V))
      CRASH(runtime_error, "Buffer::as: Size mismatch");
    return *reinterpret_cast<const S *>(data);
  }

  template <typename S> inline void to(S &out) const { out = as<S>(); }

  template <typename S> inline const Buffer &operator>>(S &out) const {
    out = as<S>();
    return *this;
  }
};

/**
 * @brief Stack-allocated buffer with compile-time size.
 *
 * @tparam V The type of elements stored in the buffer
 * @tparam N The number of elements in the buffer
 */
template <typename V, size_t N> class StaticBuffer : public Buffer<V> {
private:
  V storage[N]; ///< Internal storage array

public:
  /** @brief Construct a static buffer with N elements. */
  StaticBuffer() : Buffer<V>(storage, N) {}
  virtual ~StaticBuffer() = default;

  // Delete copy operations (base class pointer would be invalidated)
  StaticBuffer(const StaticBuffer &) = delete;
  StaticBuffer &operator=(const StaticBuffer &) = delete;

  // Move operations could be defined if needed, but delete for safety
  StaticBuffer(StaticBuffer &&) = delete;
  StaticBuffer &operator=(StaticBuffer &&) = delete;
};
