// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <cstdint>
#include <cstring>
#include <stdint.h>

#include <Buffer/VectorBuffer.h>

namespace COBS {

class RX {
  uint8_t buffer[255];
  uint8_t counter = 0, length = 0;
  inline void reset() {
    length = 0;
    counter = 0;
  }
  // Indicates if ring buffer currently holds a complete packet
  inline bool sealed() const { return length > 0 && counter == 0; }

  std::vector<uint8_t> pop(size_t n) {
    if (n > length)
      n = length;
    std::vector<uint8_t> result(n);
    std::memcpy(result.data(), buffer, n);
    length = 0;
    return result;
  }

  void push(uint8_t byte) {
    if (length == sizeof(buffer))
      CRASH(runtime_error, "COBS::RX::push: Buffer overflow");
    buffer[length++] = byte;
  }

public:
  inline uint8_t const len() const { return length; }
  inline bool recv(uint8_t byte) {
    if (sealed()) // !isEmpty() && counter == 0
      CRASH(runtime_error, "COBS::RX::recv: Previous packet not cleared");
    if (length == 0 && counter == 0) {
      // Waiting for first non-zero byte
      counter = byte;
      return false;
    }
    // At this point, counter must be greater than zero
    counter--;
    if (counter > 0) {
      if (byte != 0 && !(length == sizeof(buffer)))
        push(byte);
      else
        reset();
    } else {
      counter = byte;
      if (counter)
        push(0);
    }
    return counter == 0;
  }
  inline std::vector<uint8_t> get() {
    if (!sealed())
      CRASH(runtime_error, "COBS::RX::get: Packet not complete");
    return pop(length);
  }
  inline RX() {}
};

} // namespace COBS
