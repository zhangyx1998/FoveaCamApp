#pragma once

#include <cstddef>
#include <cstdint>

namespace Codec {

inline size_t packed12Size(size_t count) { return (count * 3 + 1) / 2; }

inline void pack12p(const uint16_t *src, uint8_t *dst, size_t count) {
  size_t o = 0;
  size_t i = 0;
  for (; i + 1 < count; i += 2) {
    const uint16_t a = src[i] & 0x0FFF;
    const uint16_t b = src[i + 1] & 0x0FFF;
    dst[o++] = static_cast<uint8_t>(a & 0xFF);
    dst[o++] = static_cast<uint8_t>(((b & 0x000F) << 4) | (a >> 8));
    dst[o++] = static_cast<uint8_t>(b >> 4);
  }
  if (i < count) {
    const uint16_t a = src[i] & 0x0FFF;
    dst[o++] = static_cast<uint8_t>(a & 0xFF);
    dst[o++] = static_cast<uint8_t>((a >> 8) & 0x0F);
  }
}

inline void unpack12p(const uint8_t *src, uint16_t *dst, size_t count) {
  const size_t pairs = count / 2;
  size_t s = 0;
  for (size_t i = 0; i < pairs; ++i, s += 3) {
    const uint8_t b0 = src[s], b1 = src[s + 1], b2 = src[s + 2];
    dst[2 * i] = static_cast<uint16_t>(b0 | ((b1 & 0x0F) << 8));
    dst[2 * i + 1] = static_cast<uint16_t>((b1 >> 4) | (b2 << 4));
  }
  if (count & 1) {
    const uint8_t b0 = src[s], b1 = src[s + 1];
    dst[count - 1] = static_cast<uint16_t>(b0 | ((b1 & 0x0F) << 8));
  }
}

} // namespace Codec
