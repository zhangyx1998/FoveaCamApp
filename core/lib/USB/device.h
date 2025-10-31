#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <libusb-1.0/libusb.h>

namespace USB {

class USB_Interface : public libusb_interface_descriptor {
public:
  const uint8_t bNumEndpoints = 0;
  const void *endpoint = NULL;
  std::vector<struct libusb_endpoint_descriptor> endpoints;
  USB_Interface(struct libusb_interface_descriptor desc);
};

class Device {
protected:
  uint16_t vid, pid;
  libusb_device_handle *handle = NULL;
  libusb_context *ctx = NULL;

public:
  Device(uint16_t idVendor, uint16_t idProduct);
  ~Device();
  std::string id();
  // Utility function to locate interfaces by given class id
  std::vector<USB_Interface> interfaces();
  // Utility function to locate interfaces by given class id
  std::vector<USB_Interface> interfaces(uint8_t class_id);
  // Utility function to locate interfaces by given class id and subclass id
  std::vector<USB_Interface> interfaces(uint8_t class_id, uint8_t subclass_id);
};

} // namespace USB
