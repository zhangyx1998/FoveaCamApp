// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <COBS/RX.h>
#include <COBS/TX.h>
#include <cstdlib>

COBS::RX rx;
COBS::TX tx;

void report(const char *msg, const uint8_t *data, size_t len) {
  printf("%s: (%zu bytes)", msg, len);
  for (size_t i = 0; i < len; i++)
    printf("%02X ", data[i]);
  printf("\n");
}

std::vector<uint8_t> generate() {
  // Randomly generate some data
  size_t len = rand() % 253 + 1;
  std::vector<uint8_t> data(len);
  for (size_t i = 0; i < len; i++)
    data[i] = rand() % 256;
  return data;
}

void test(std::vector<uint8_t> data) {
  // Encode
  auto ret = tx.encode(data);
  if (!ret) {
    report("TX::encode failed", data.data(), data.size());
    exit(1);
  }
  // Decode
  ret = false;
  for (size_t i = 0; i < tx.size(); i++) {
    if (ret) {
      report("RX::recv: Terminate too early", tx.data(), tx.size());
      exit(1);
    }
    ret = rx.recv(tx.data()[i]);
  }
  if (!ret) {
    report("RX::recv: Did not terminate", tx.data(), tx.size());
    exit(1);
  }
  // Check data
  auto decoded = rx.get();
  if (decoded.size() != data.size()) {
    report("RX::recv: Size mismatch src = ", tx.data(), tx.size());
    report("RX::recv: Size mismatch dst = ", decoded.data(), decoded.size());
    exit(1);
  }
  for (size_t i = 0; i < data.size(); i++) {
    if (decoded[i] != data[i]) {
      report("RX::recv: Data mismatch src = ", tx.data(), tx.size());
      report("RX::recv: Data mismatch dst = ", decoded.data(), decoded.size());
      exit(1);
    }
  }
}

int main() {
  for (int i = 0; i < 1000; i++) {
    auto data = generate();
    try {
      test(data);
    } catch (const std::exception &e) {
      report(e.what(), data.data(), data.size());
      exit(1);
    }
  }
  printf("All tests passed\n");
  return 0;
}
