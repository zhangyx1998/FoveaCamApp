#include "device.h"

#include "util/assert.h"

namespace USB {

USB_Interface::USB_Interface(struct libusb_interface_descriptor desc)
    : libusb_interface_descriptor(desc) {
  for (unsigned i = 0; i < desc.bNumEndpoints; i++) {
    this->endpoints.push_back(desc.endpoint[i]);
  }
}

Device::Device(uint16_t idVendor, uint16_t idProduct)
    : vid(idVendor), pid(idProduct) {
  int ret = libusb_init(&ctx);
  ASSERT(ret == LIBUSB_SUCCESS,
         "Failed to initialize libusb: " + std::string(libusb_error_name(ret)));
  handle = libusb_open_device_with_vid_pid(ctx, idVendor, idProduct);
  ASSERT(handle, "Failed to open device " + id());
}

Device::~Device() {
  // Close the device
  if (handle)
    libusb_close(handle);
  // Deinitialize current libusb context
  libusb_exit(ctx);
}

std::string Device::id() {
  return std::to_string(vid) + ":" + std::to_string(pid);
}

std::vector<USB_Interface> Device::interfaces() {
  auto device = libusb_get_device(handle);
  ASSERT(device, "Device is null");

  struct libusb_config_descriptor *config;
  int ret = libusb_get_active_config_descriptor(device, &config);
  ASSERT(ret == LIBUSB_SUCCESS, "Failed to get active config descriptor");

  std::vector<USB_Interface> result;
  for (uint8_t i = 0; i < config->bNumInterfaces; i++) {
    for (int j = 0; j < config->interface[i].num_altsetting; j++) {
      result.push_back(config->interface[i].altsetting[j]);
    }
  }

  return result;
}

std::vector<USB_Interface> Device::interfaces(uint8_t class_id) {
  std::vector<USB_Interface> result;
  for (auto &desc : this->interfaces()) {
    if (desc.bInterfaceClass == class_id) {
      result.push_back(desc);
    }
  }
  return result;
}

std::vector<USB_Interface> Device::interfaces(uint8_t class_id,
                                          uint8_t subclass_id) {
  std::vector<USB_Interface> result;
  for (auto &desc : this->interfaces(class_id)) {
    if (desc.bInterfaceSubClass == subclass_id) {
      result.push_back(desc);
    }
  }
  return result;
}

} // namespace USB
