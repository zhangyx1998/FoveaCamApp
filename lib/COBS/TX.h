// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <cstdint>
#include <stdint.h>

#include <Buffer/RingBuffer.h>

namespace COBS {

constexpr uint8_t MaxPacketSize = 254;

class TX {
  uint8_t _buffer[256];
  unsigned _size = 0;

public:
  inline const uint8_t *data() const { return _buffer; }
  inline const unsigned &size() const { return _size; }
  inline bool encode(const uint8_t *data, size_t len) {
    if (len > MaxPacketSize)
      return false;
    // +1 for initial counter, +1 for end byte
    _size = len + 2;
    auto counter = &_buffer[0];
    auto ptr = &_buffer[1];
    *counter = 1;
    for (size_t i = 0; i < len; i++) {
      auto &byte = data[i];
      if (byte != 0) {
        *ptr++ = byte;
        (*counter)++;
      } else {
        counter = ptr++;
        *counter = 1;
      }
    }
    *ptr = 0; // End byte
    return true;
  }
  inline bool encode(const std::vector<uint8_t> &data) {
    return encode(data.data(), data.size());
  }
  template <typename T> bool encode(const T &data) {
    static_assert(sizeof(T) <= MaxPacketSize,
                  "COBS::TX::encode<T>: T is too large");
    return encode(reinterpret_cast<const uint8_t *>(&data), sizeof(T));
  }
};

} // namespace COBS
