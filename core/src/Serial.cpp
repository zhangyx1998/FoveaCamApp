// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstddef>
#include <cstring>

#include <napi.h>
#include <sys/fcntl.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

#include <Aravis/Camera.h>
#include <Aravis/Frame.h>
#include <Aravis/Stream.h>
#include <COBS/RX.h>
#include <COBS/TX.h>
#include <Protocol/Packet.h>
#include <Threading/Guard.h>
#include <convert.h>
#include <pointer.h>

#include "napi-helper.h"

// Used by Protocol object constructor.

int SerialOpen(const Napi::CallbackInfo &info) noexcept {
  const auto env = info.Env();
  const auto path = convert<std::string>(info[0]);
  const auto baud = optionalArgument<speed_t>(info[1], 115200);
  VERBOSE("Opening serial port %s (baudrate=%lu)", path.c_str(), baud);
  // Open serial port
  int fd = ::open(path.c_str(), O_RDWR | O_NOCTTY | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0)
    JS_THROW(Error, "Failed to open serial port: " + path, -1);

  // Set exclusive access (macOS/BSD) to prevent interference from other
  // processes
#ifdef TIOCEXCL
  if (ioctl(fd, TIOCEXCL) == -1) {
    WARN("Failed to set exclusive access on serial port: %s",
         std::strerror(errno));
    // Not fatal - continue anyway
  }
#endif

  // Configure serial port
  struct termios tty;
  if (tcgetattr(fd, &tty) != 0) {
    ::close(fd);
    JS_THROW(Error, "Failed to get serial port attributes", -1);
  }
  // Set baud rate
  switch (baud) {
  case 9600:
  case 19200:
  case 38400:
  case 57600:
  case 115200:
  case 230400:
    break;
  default:
    ::close(fd);
    JS_THROW(Error, "Unsupported baud rate: " + std::to_string(baud), -1);
  }
  cfsetispeed(&tty, baud);
  cfsetospeed(&tty, baud);
  // Configure 8N1 (8 data bits, no parity, 1 stop bit) by default
  tty.c_cflag &= ~PARENB; // No parity
  tty.c_cflag &= ~CSTOPB; // 1 stop bit
  tty.c_cflag &= ~CSIZE;
  tty.c_cflag |= CS8; // 8 data bits
  // Disable hardware flow control
  tty.c_cflag &= ~CRTSCTS;
  // Enable reading and ignore modem control lines
  tty.c_cflag |= CREAD | CLOCAL;
  // Disable canonical mode, echo, and signal chars
  tty.c_lflag &= ~(ICANON | ECHO | ECHOE | ECHONL | ISIG);
  // Disable software flow control and special handling
  tty.c_iflag &= ~(IXON | IXOFF | IXANY);
  tty.c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL);
  // Disable output processing
  tty.c_oflag &= ~OPOST;
  tty.c_oflag &= ~ONLCR;
  // Set read timeout to non-blocking
  tty.c_cc[VTIME] = 0;
  tty.c_cc[VMIN] = 0;
  // Apply settings
  if (tcsetattr(fd, TCSANOW, &tty) != 0) {
    ::close(fd);
    JS_THROW(Error, "Failed to set serial port attributes", -1);
  }
  // Flush any existing data
  tcflush(fd, TCIOFLUSH);
  // fd now ready for use
  return fd;
}
