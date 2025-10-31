#pragma once

#include "device.h"

#define LITTLE_ENDIAN_16(X) (uint8_t)(X) & 0xFF, (uint8_t)((X) >> 8) & 0xFF
#define LITTLE_ENDIAN_32(X) LITTLE_ENDIAN_16(X), LITTLE_ENDIAN_16((X) >> 16)

namespace USB {

class SerialDevice : public Device {
private:
  struct {
    // USB endpoints
    unsigned char cdc_in, cdc_out;
  } endpoint;
public:
  SerialDevice(uint16_t idVendor, uint16_t idProduct,
               uint32_t baudrate = 115200);
  ~SerialDevice();
  size_t read(uint8_t *data, size_t cap, size_t offset = 0);
  int write(uint8_t *data, size_t count);
};

} // namespace USB
