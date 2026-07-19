#include <Codec/Packed12.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

namespace {

struct Vector {
  std::string name;
  std::vector<uint16_t> samples;
  std::vector<uint8_t> packed;
};

std::string readFixture() {
  for (const char *path : {"../docs/schema/codec/12p-vectors.json",
                           "../../docs/schema/codec/12p-vectors.json"}) {
    std::ifstream file(path);
    if (!file)
      continue;
    std::stringstream ss;
    ss << file.rdbuf();
    return ss.str();
  }
  std::cerr << "Cannot open 12p fixture\n";
  std::exit(1);
}

std::vector<uint16_t> parseSamples(const std::string &text) {
  std::vector<uint16_t> out;
  std::stringstream ss(text);
  std::string token;
  while (std::getline(ss, token, ',')) {
    token.erase(std::remove_if(token.begin(), token.end(), ::isspace),
                token.end());
    if (!token.empty())
      out.push_back(static_cast<uint16_t>(std::stoul(token)));
  }
  return out;
}

std::vector<uint8_t> parseHex(const std::string &hex) {
  std::vector<uint8_t> out;
  if (hex.size() % 2 != 0) {
    std::cerr << "Odd hex length in fixture\n";
    std::exit(1);
  }
  for (size_t i = 0; i < hex.size(); i += 2)
    out.push_back(static_cast<uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
  return out;
}

std::vector<Vector> loadVectors() {
  const auto json = readFixture();
  const std::regex objectRe(
      R"re(\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"samples"\s*:\s*\[([^\]]*)\]\s*,\s*"packedHex"\s*:\s*"([0-9a-fA-F]+)")re");
  std::vector<Vector> out;
  for (auto it = std::sregex_iterator(json.begin(), json.end(), objectRe);
       it != std::sregex_iterator(); ++it) {
    out.push_back({(*it)[1].str(), parseSamples((*it)[2].str()),
                   parseHex((*it)[3].str())});
  }
  return out;
}

void require(bool ok, const std::string &message) {
  if (!ok) {
    std::cerr << message << "\n";
    std::exit(1);
  }
}

} // namespace

int main() {
  const auto vectors = loadVectors();
  require(!vectors.empty(), "No vectors parsed from 12p fixture");
  for (const auto &v : vectors) {
    require(Codec::packed12Size(v.samples.size()) == v.packed.size(),
            v.name + ": packed size mismatch");
    std::vector<uint8_t> packed(v.packed.size());
    Codec::pack12p(v.samples.data(), packed.data(), v.samples.size());
    require(packed == v.packed, v.name + ": pack mismatch");
    std::vector<uint16_t> unpacked(v.samples.size());
    Codec::unpack12p(v.packed.data(), unpacked.data(), v.samples.size());
    require(unpacked == v.samples, v.name + ": unpack mismatch");
  }
  std::cout << "12p fixture tests passed\n";
  return 0;
}
