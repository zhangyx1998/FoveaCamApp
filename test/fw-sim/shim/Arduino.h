// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Host HAL shim: the <Arduino.h> surface the REAL firmware translation units
// compile against on the host.
// Implementations live in test/fw-sim/hal.cpp — micros() off the steady
// clock (uint32, preserving Teensy wrap semantics), noInterrupts()/
// interrupts() as a recursive-mutex pair, a recording pin table (Board.h's
// Pin<> works unchanged), and a Serial that fronts the sim's pty master.
// Constants keep the Teensy 4 values so Board.h's `switch (Mode)` cases stay
// distinct and the recorded pin modes read the same as on-device.

#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

// Exceptions are ON in this host build, so lib/crash.h's CRASH(type, ERR)
// EVALUATES its message argument (the MCU's exceptions-off variant merely
// stringifies it) — Protocol.h's inflate() then needs type_name<T>() in
// scope. Provide it here (<Arduino.h> is every firmware TU's first include)
// instead of editing lib/.
#include <type_name.h>

// --- Teensy core constants (values mirror teensy4/core_pins.h) --------------
#define LOW (0)
#define HIGH (1)
#define INPUT (0)
#define OUTPUT (1)
#define INPUT_PULLUP (2)
#define INPUT_PULLDOWN (3)
#define OUTPUT_OPENDRAIN (4)
#define INPUT_DISABLE (5)
#define FALLING (2)
#define RISING (3)
#define CHANGE (4)
#define LED_BUILTIN (13)

// --- Time ---------------------------------------------------------------------
// uint32_t like Teensy's micros(): Global::time (Time<micros, uint64_t>) keys
// its wraparound-correct anchor math on this exact return type.
uint32_t micros();
void delay(uint32_t ms);
void delayMicroseconds(uint32_t us);
void delayNanoseconds(uint32_t ns);

// --- GPIO ----------------------------------------------------------------------
void pinMode(unsigned pin, unsigned mode);
void digitalWrite(unsigned pin, uint8_t val);
uint8_t digitalRead(unsigned pin);
inline uint8_t digitalReadFast(unsigned pin) { return digitalRead(pin); }
void analogWrite(unsigned pin, unsigned duty);
void analogWriteFrequency(unsigned pin, float freq);
void attachInterrupt(unsigned pin, void (*isr)(), int mode);

// noInterrupts()/interrupts() — a recursive-mutex lock/unlock pair. Injected
// strobe "ISRs" acquire the same mutex, so firmware critical
// sections exclude them exactly like cli/sei does on the MCU.
void noInterrupts();
void interrupts();

// Teensy reboot hook (HARD reset path, and the SOFT path under
// FOVEA_HOST_SIM). The sim reports and exits — a reboot ends the session.
[[noreturn]] void _reboot_Teensyduino_();

// lib/crash.h only declares crash() when exceptions are OFF. This host build
// keeps exceptions ON (CRASH throws, matching core), but firmware/src/
// Protocol.cpp still calls crash() explicitly on the reset path and
// firmware/src/Global.cpp defines it — surface the declaration here
// (<Arduino.h> is every firmware TU's first include).
void crash(std::string err);

// --- Serial ----------------------------------------------------------------------
// Fronts the pty MASTER owned by the sim main (Sim::serialFd). Non-blocking
// reads (available() refills an internal buffer), blocking-ish writes (poll +
// retry on a full pty buffer, bounded).
class HostSerial {
public:
  void begin(unsigned long baud);
  int available();
  int read();
  size_t write(const uint8_t *data, size_t len);
  size_t println(const char *s);

private:
  uint8_t rxBuf[4096];
  size_t rxHead = 0, rxLen = 0;
};

extern HostSerial Serial;
