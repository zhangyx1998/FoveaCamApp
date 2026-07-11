// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Host <SPI.h> shim (docs/proposals/firmware-sim-harness.md): the MEMS-SPI
// DAC-word capture. firmware/src/MEMS.cpp + MEMS-SPI.h compile unchanged;
// every begin/endTransaction pair's transferred bytes are committed as one
// DAC word to the sim's control plane (Sim::onDacWord), with the CS pins
// (Board::mems_cs, LOW = selected) sampled at commit time. Transfers outside
// a transaction (MEMS.cpp's 8-cycle delay byte) are ignored.

#pragma once

#include <cstddef>
#include <cstdint>

#define MSBFIRST 1
// Value irrelevant on host — only threaded through SPISettings.
#define SPI_MODE2 0x40

class SPISettings {
public:
  uint32_t clock;
  uint8_t bitOrder;
  uint8_t dataMode;
  constexpr SPISettings(uint32_t clock, uint8_t bitOrder, uint8_t dataMode)
      : clock(clock), bitOrder(bitOrder), dataMode(dataMode) {}
};

class SPIClass {
public:
  void begin();
  void beginTransaction(const SPISettings &settings);
  uint8_t transfer(uint8_t byte);
  void endTransaction();

private:
  bool inTransaction = false;
  uint8_t word[8];
  size_t wordLen = 0;
};

extern SPIClass SPI;
