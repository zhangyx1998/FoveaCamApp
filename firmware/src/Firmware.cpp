// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>
#include <SPI.h>

#include <Protocol/Packet.h>
#include <Protocol/Protocol.h>

#include "Board.h"
#include "Global.h"

void setup() {
  Serial.begin(115200);
  SPI.begin();
  Board::init();
  Board::low_pass_filter.freq(Global::lpf_frequency);
}

void handle(const Protocol::RawPacket &&packet);

void loop() {
  Global::time.update();
  auto byte = Serial.read();
  if (byte >= 0 && COBS::rx.recv(byte))
    handle(COBS::rx.get());
}

#define HEADER(M, P)                                                           \
  (Protocol::header(Protocol::Method::M, Protocol::Property::P))

#define CASE_GET(P)                                                            \
  case Protocol::header(Protocol::Method::GET, Packet::P::PROPERTY):           \
    Packet::P::GET(seq);                                                       \
    break;

#define CASE_SET(P)                                                            \
  case Protocol::header(Protocol::Method::SET, Packet::P::PROPERTY): {         \
    if (Packet::P::validate(packet))                                           \
      Packet::P::SET(seq, Packet::P::inflate(packet));                         \
    else                                                                       \
      Packet::P::reject(seq, "Invalid packet");                                \
    break;                                                                     \
  }

void handle(const Protocol::RawPacket &&packet) {
  const auto header = packet.validate();
  const auto &seq = packet.header().sequence;
  switch (header) {
    CASE_GET(System::Info);
    CASE_GET(System::Version);
    CASE_SET(System::Reset);
    CASE_GET(System::Enable);
    CASE_SET(System::Enable);
    CASE_GET(Config::Log);
    CASE_SET(Config::Log);
    CASE_GET(Config::LPF);
    CASE_SET(Config::LPF);
    CASE_GET(Config::Bias);
    CASE_SET(Config::Bias);
    CASE_SET(Command::Actuate);
    CASE_SET(Command::Trigger);
  case Protocol::INVALID: {
    auto packet = Packet::reject("Bad packet");
    if (COBS::tx.encode(packet))
      Serial.write(COBS::tx.data(), COBS::tx.size());
    break;
  }
  default: {
    auto packet = Packet::reject("Unknown packet type");
    if (COBS::tx.encode(packet))
      Serial.write(COBS::tx.data(), COBS::tx.size());
    break;
  }
  }
};
