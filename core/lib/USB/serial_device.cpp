#include "serial_device.h"

#include "util/assert.h"
#include <libusb-1.0/libusb.h>
#include <stdexcept>

#define ACM_CTRL_DTR 0x01
#define ACM_CTRL_RTS 0x02

namespace USB {

SerialDevice::SerialDevice(uint16_t idVendor, uint16_t idProduct,
                           uint32_t baudrate)
    : Device(idVendor, idProduct) {
  int ret;
  /* As we are dealing with a CDC-ACM device, it's highly probable that
   * Linux already attached the cdc-acm driver to this device.
   * We need to detach the drivers from all the USB interfaces. The CDC-ACM
   * Class defines two interfaces: the Control interface and the
   * Data interface.
   */
  for (int if_num = 0; if_num < 2; if_num++) {
    if (libusb_kernel_driver_active(handle, if_num)) {
      libusb_detach_kernel_driver(handle, if_num);
    }
    ret = libusb_claim_interface(handle, if_num);
    ASSERT(ret >= 0,
           std::string("Failed claiming interface: ") + libusb_error_name(ret));
  }
  // Start configuring the device:
  // Set line state
  ret = libusb_control_transfer(handle, 0x21, 0x22, ACM_CTRL_DTR | ACM_CTRL_RTS,
                                0, NULL, 0, 0);
  ASSERT(ret >= 0,
         "Error setting line state: " + std::string(libusb_error_name(ret)));
  // Set line encoding (115200 Baud, 8N1):
  uint8_t encoding[] = {LITTLE_ENDIAN_32(115200), 0x00, 0x00, 0x08};
  ret = libusb_control_transfer(handle, 0x21, 0x20, 0, 0, encoding,
                                sizeof(encoding), 0);
  ASSERT(ret >= 0,
         "Error setting line encoding: " + std::string(libusb_error_name(ret)));
  // Get the endpoints' addresses
  bool found_in = false, found_out = false;
  for (const auto &desc : interfaces(LIBUSB_CLASS_DATA)) {
    for (const auto &endpoint : desc.endpoints) {
      if (endpoint.bEndpointAddress & LIBUSB_ENDPOINT_IN) {
        this->endpoint.cdc_in = endpoint.bEndpointAddress;
        found_in = true;
      } else {
        this->endpoint.cdc_out = endpoint.bEndpointAddress;
        found_out = true;
      }
    }
  }
  ASSERT(found_in && found_out, "Failed to locate endpoints (" + id() + ", " +
                                    std::to_string(found_in) + ":" +
                                    std::to_string(found_out) + ")");
}

SerialDevice::~SerialDevice() {
  // Release the interfaces
  for (int if_num = 0; if_num < 2; if_num++) {
    libusb_release_interface(handle, if_num);
  }
}

size_t SerialDevice::read(uint8_t *data, size_t cap, size_t offset) {
  int actual_length;
  /* To receive characters from the device initiate a bulk_transfer to the
   * Endpoint with address ep_in_addr.
   */
  if (offset >= cap) {
    return cap;
  }
  const int ret = libusb_bulk_transfer(handle, endpoint.cdc_in, data + offset,
                                       cap - offset, &actual_length, 1);
  switch (ret) {
  case LIBUSB_SUCCESS:
  case LIBUSB_ERROR_TIMEOUT:
    break;
  default:
    ASSERT(ret >= 0, "Error reading serial device: " +
                         std::string(libusb_error_name(ret)))
  }
  return offset + actual_length;
}

int SerialDevice::write(uint8_t *data, size_t count) {
  /* To send a char to the device simply initiate a bulk_transfer to the
   * output endpoint.
   */
  int bytes_sent;
  auto ret = libusb_bulk_transfer(handle, endpoint.cdc_out, data, count,
                                  &bytes_sent, 0);
  switch (ret) {
  case LIBUSB_SUCCESS:
  case LIBUSB_ERROR_TIMEOUT:
    break;
  default:
    ASSERT(ret >= 0, "Error writing serial device: " +
                         std::string(libusb_error_name(ret)))
  }
  return bytes_sent;
}

} // namespace USB
