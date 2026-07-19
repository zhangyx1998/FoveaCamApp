// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// See McapWriter.h. Byte layout mirrored from @mcap/core (McapRecordBuilder.ts +
// McapWriter.ts + ChunkBuilder.ts) — every integer little-endian, strings are a
// u32 byte-length prefix + UTF-8, maps are a u32 byte-length prefix + packed
// pairs, and each record is `opcode(u8) | length(u64 body-bytes) | body`.

#include "Record/McapWriter.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <stdexcept>
#include <unistd.h>

#include <zlib.h>

namespace Record {

namespace {

// MCAP magic: \x89 M C A P 0 \r \n
constexpr uint8_t kMagic[8] = {0x89, 0x4D, 0x43, 0x41, 0x50, 0x30, 0x0D, 0x0A};

enum Opcode : uint8_t {
  OP_HEADER = 0x01,
  OP_FOOTER = 0x02,
  OP_SCHEMA = 0x03,
  OP_CHANNEL = 0x04,
  OP_MESSAGE = 0x05,
  OP_CHUNK = 0x06,
  OP_MESSAGE_INDEX = 0x07,
  OP_CHUNK_INDEX = 0x08,
  OP_STATISTICS = 0x0B,
  OP_METADATA = 0x0C,
  OP_METADATA_INDEX = 0x0D,
  OP_SUMMARY_OFFSET = 0x0E,
  OP_DATA_END = 0x0F,
};

using Bytes = std::vector<uint8_t>;

inline void putU8(Bytes &v, uint8_t x) { v.push_back(x); }
inline void putU16(Bytes &v, uint16_t x) {
  v.push_back(static_cast<uint8_t>(x));
  v.push_back(static_cast<uint8_t>(x >> 8));
}
inline void putU32(Bytes &v, uint32_t x) {
  for (int i = 0; i < 4; ++i)
    v.push_back(static_cast<uint8_t>(x >> (8 * i)));
}
inline void putU64(Bytes &v, uint64_t x) {
  for (int i = 0; i < 8; ++i)
    v.push_back(static_cast<uint8_t>(x >> (8 * i)));
}
inline void putBytes(Bytes &v, const uint8_t *d, size_t n) {
  v.insert(v.end(), d, d + n);
}
inline void putStr(Bytes &v, const std::string &s) {
  putU32(v, static_cast<uint32_t>(s.size()));
  putBytes(v, reinterpret_cast<const uint8_t *>(s.data()), s.size());
}
// A Map<string,string> field: u32 byte-length prefix (of the pair region, not
// counting the prefix itself), then packed (string key, string value) pairs.
inline void putStrMap(Bytes &v, const MetaMap &m) {
  size_t at = v.size();
  putU32(v, 0); // placeholder byte length
  for (const auto &[k, val] : m) {
    putStr(v, k);
    putStr(v, val);
  }
  uint32_t bodyLen = static_cast<uint32_t>(v.size() - at - 4);
  for (int i = 0; i < 4; ++i)
    v[at + i] = static_cast<uint8_t>(bodyLen >> (8 * i));
}

// Record framing helpers. begin() writes opcode + a u64 length placeholder and
// returns the placeholder offset; end() backpatches the body length.
inline size_t beginRecord(Bytes &v, uint8_t op) {
  putU8(v, op);
  size_t lenPos = v.size();
  putU64(v, 0);
  return lenPos;
}
inline void endRecord(Bytes &v, size_t lenPos) {
  uint64_t bodyLen = static_cast<uint64_t>(v.size() - lenPos - 8);
  for (int i = 0; i < 8; ++i)
    v[lenPos + i] = static_cast<uint8_t>(bodyLen >> (8 * i));
}

inline uint32_t crcInit() {
  return static_cast<uint32_t>(::crc32(0L, Z_NULL, 0));
}
inline uint32_t crcUpdate(uint32_t crc, const uint8_t *d, size_t n) {
  return static_cast<uint32_t>(
      ::crc32(crc, reinterpret_cast<const Bytef *>(d), static_cast<uInt>(n)));
}

// Append one full Schema record — shared by chunk-inline and summary-repeat
// emission.
void writeSchemaRecord(Bytes &v, uint16_t id, const std::string &name,
                       const std::string &encoding, const Bytes &data) {
  size_t lp = beginRecord(v, OP_SCHEMA);
  putU16(v, id);
  putStr(v, name);
  putStr(v, encoding);
  putU32(v, static_cast<uint32_t>(data.size()));
  putBytes(v, data.data(), data.size());
  endRecord(v, lp);
}

} // namespace

McapWriter::McapWriter(uint64_t chunkSize) : chunkSize_(chunkSize) {}

McapWriter::~McapWriter() {
  if (fd_ >= 0)
    ::close(fd_);
}

void McapWriter::emit(const uint8_t *d, size_t n, uint32_t *crc) {
  if (n == 0)
    return;
  if (crc)
    *crc = crcUpdate(*crc, d, n);
  size_t off = 0;
  while (off < n) {
    ssize_t w = ::write(fd_, d + off, n - off);
    if (w < 0) {
      if (errno == EINTR)
        continue;
      throw std::runtime_error(std::string("McapWriter: write failed: ") +
                               std::strerror(errno));
    }
    off += static_cast<size_t>(w);
  }
  position_ += n;
}

void McapWriter::flush(uint32_t *crc) {
  if (buf_.empty())
    return;
  emit(buf_.data(), buf_.size(), crc);
  buf_.clear();
}

void McapWriter::open(const std::string &path, const std::string &profile,
                      const std::string &library) {
  fd_ = ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd_ < 0)
    throw std::runtime_error(std::string("McapWriter: open failed: ") +
                             std::strerror(errno));
  dataSectionCrc_ = crcInit();
  // Leading magic + Header, written as the first data-section bytes.
  putBytes(buf_, kMagic, sizeof(kMagic));
  size_t lp = beginRecord(buf_, OP_HEADER);
  putStr(buf_, profile);
  putStr(buf_, library);
  endRecord(buf_, lp);
  flush(&dataSectionCrc_);
}

uint16_t McapWriter::registerSchema(const std::string &name,
                                    const std::string &encoding,
                                    const uint8_t *data, size_t len) {
  uint16_t id = nextSchemaId_++;
  schemas_[id] = SchemaRec{name, encoding, Bytes(data, data + len)};
  ++schemaCount_;
  return id;
}

uint16_t McapWriter::registerChannel(uint16_t schemaId, const std::string &topic,
                                     const std::string &messageEncoding,
                                     const MetaMap &metadata) {
  uint16_t id = nextChannelId_++;
  channels_[id] = ChannelRec{schemaId, topic, messageEncoding, metadata};
  ++channelCount_;
  return id;
}

McapWriter::ChanIndex &McapWriter::chunkChannelIndex(uint16_t channelId) {
  auto it = chunkIndexLookup_.find(channelId);
  if (it != chunkIndexLookup_.end())
    return chunkIndex_[it->second];
  chunkIndexLookup_[channelId] = chunkIndex_.size();
  chunkIndex_.push_back(ChanIndex{channelId, {}});
  return chunkIndex_.back();
}

uint64_t &McapWriter::channelMessageCount(uint16_t channelId) {
  auto it = channelMsgCountIdx_.find(channelId);
  if (it != channelMsgCountIdx_.end())
    return channelMsgCounts_[it->second].second;
  channelMsgCountIdx_[channelId] = channelMsgCounts_.size();
  channelMsgCounts_.push_back({channelId, 0});
  return channelMsgCounts_.back().second;
}

void McapWriter::addMessage(uint16_t channelId, uint32_t sequence,
                            uint64_t logTime, uint64_t publishTime,
                            const uint8_t *data, size_t len) {
  // ---- statistics ----
  if (msgCount_ == 0) {
    msgStartTime_ = logTime;
    msgEndTime_ = logTime;
  } else {
    if (logTime < msgStartTime_)
      msgStartTime_ = logTime;
    if (logTime > msgEndTime_)
      msgEndTime_ = logTime;
  }
  channelMessageCount(channelId) += 1;
  ++msgCount_;

  // ---- lazy schema/channel emission into the open chunk ----
  auto chIt = channels_.find(channelId);
  if (chIt == channels_.end())
    throw std::runtime_error("McapWriter::addMessage: unknown channelId");
  const ChannelRec &ch = chIt->second;
  if (!writtenChannel_[channelId]) {
    if (ch.schemaId != 0 && !writtenSchema_[ch.schemaId]) {
      auto sIt = schemas_.find(ch.schemaId);
      if (sIt == schemas_.end())
        throw std::runtime_error("McapWriter::addMessage: unknown schemaId");
      writeSchemaRecord(chunk_, ch.schemaId, sIt->second.name,
                        sIt->second.encoding, sIt->second.data);
      writtenSchema_[ch.schemaId] = true;
    }
    // Channel record into the chunk.
    size_t lp = beginRecord(chunk_, OP_CHANNEL);
    putU16(chunk_, channelId);
    putU16(chunk_, ch.schemaId);
    putStr(chunk_, ch.topic);
    putStr(chunk_, ch.messageEncoding);
    putStrMap(chunk_, ch.metadata);
    endRecord(chunk_, lp);
    writtenChannel_[channelId] = true;
  }

  // ---- chunk message-start/end + message index ----
  if (chunkNumMsgs_ == 0 || logTime < chunkMsgStart_)
    chunkMsgStart_ = logTime;
  if (chunkNumMsgs_ == 0 || logTime > chunkMsgEnd_)
    chunkMsgEnd_ = logTime;
  // Offset is the position of this message WITHIN the uncompressed chunk records
  // (i.e. before writing it), which includes any preceding schema/channel
  // records + prior messages.
  chunkChannelIndex(channelId).records.push_back(
      {logTime, static_cast<uint64_t>(chunk_.size())});
  ++chunkNumMsgs_;

  // ---- message record ----
  size_t lp = beginRecord(chunk_, OP_MESSAGE);
  putU16(chunk_, channelId);
  putU32(chunk_, sequence);
  putU64(chunk_, logTime);
  putU64(chunk_, publishTime);
  putBytes(chunk_, data, len);
  endRecord(chunk_, lp);

  if (chunk_.size() > chunkSize_)
    finalizeChunk();
}

void McapWriter::finalizeChunk() {
  if (chunkNumMsgs_ == 0)
    return;
  ++chunkCount_;

  const uint64_t uncompressedSize = static_cast<uint64_t>(chunk_.size());
  const uint32_t uncompressedCrc = crcUpdate(crcInit(), chunk_.data(), chunk_.size());
  const uint64_t chunkStartOffset = position_;

  // Chunk record: header into buf_ (flushed), then the payload emitted directly
  // (avoids a second full copy of the chunk through buf_). On disk the two
  // segments are contiguous and form one record; chunkLength counts both.
  const uint64_t bodyLen =
      8 /*msgStart*/ + 8 /*msgEnd*/ + 8 /*uncompressedSize*/ +
      4 /*uncompressedCrc*/ + 4 /*compression string len (empty)*/ +
      8 /*records byte length*/ + uncompressedSize;
  putU8(buf_, OP_CHUNK);
  putU64(buf_, bodyLen);
  putU64(buf_, chunkMsgStart_);
  putU64(buf_, chunkMsgEnd_);
  putU64(buf_, uncompressedSize);
  putU32(buf_, uncompressedCrc);
  putStr(buf_, ""); // compression = "" (none)
  putU64(buf_, uncompressedSize); // records byte length (== uncompressed, no compression)
  flush(&dataSectionCrc_);
  emit(chunk_.data(), chunk_.size(), &dataSectionCrc_);
  const uint64_t chunkLength = 1 + 8 + bodyLen;

  // Message index records, one per channel present in the chunk (insertion
  // order), all accumulated into buf_ then flushed once. Each channel's index
  // offset (absolute file offset) is recorded for the chunk index.
  const uint64_t messageIndexStart = position_;
  ChunkIndexRec ci;
  ci.messageStartTime = chunkMsgStart_;
  ci.messageEndTime = chunkMsgEnd_;
  ci.chunkStartOffset = chunkStartOffset;
  ci.chunkLength = chunkLength;
  ci.compressedSize = uncompressedSize;
  ci.uncompressedSize = uncompressedSize;
  for (const ChanIndex &idx : chunkIndex_) {
    // Offset of THIS index record within the message-index block = current
    // buf_ length (bytes accumulated so far for earlier channels).
    ci.messageIndexOffsets.push_back(
        {idx.channelId, messageIndexStart + static_cast<uint64_t>(buf_.size())});
    size_t lp = beginRecord(buf_, OP_MESSAGE_INDEX);
    putU16(buf_, idx.channelId);
    putU32(buf_, static_cast<uint32_t>(idx.records.size() * 16));
    for (const auto &[t, off] : idx.records) {
      putU64(buf_, t);
      putU64(buf_, off);
    }
    endRecord(buf_, lp);
  }
  ci.messageIndexLength = static_cast<uint64_t>(buf_.size());
  flush(&dataSectionCrc_);
  chunkIndices_.push_back(std::move(ci));

  // Reset open-chunk state.
  chunk_.clear();
  chunkIndex_.clear();
  chunkIndexLookup_.clear();
  chunkNumMsgs_ = 0;
  chunkMsgStart_ = 0;
  chunkMsgEnd_ = 0;
}

McapWriter::Stats McapWriter::end() {
  if (closed_)
    return stats();
  finalizeChunk();

  // Any residual top-level buffer (normally empty) folds into the data CRC.
  flush(&dataSectionCrc_);

  // DataEnd.
  {
    size_t lp = beginRecord(buf_, OP_DATA_END);
    putU32(buf_, dataSectionCrc_);
    endRecord(buf_, lp);
    // DataEnd is NOT part of the data-section CRC — flush without updating it.
    flush(nullptr);
  }

  uint32_t summaryCrc = crcInit();
  const uint64_t summaryStart = position_;

  struct Group {
    uint8_t op;
    uint64_t start;
    uint64_t length;
  };
  std::vector<Group> groups;

  // Repeated schemas.
  {
    uint64_t start = position_;
    for (const auto &[id, s] : schemas_)
      writeSchemaRecord(buf_, id, s.name, s.encoding, s.data);
    uint64_t length = static_cast<uint64_t>(buf_.size());
    flush(&summaryCrc);
    groups.push_back({OP_SCHEMA, start, length});
  }
  // Repeated channels.
  {
    uint64_t start = position_;
    for (const auto &[id, c] : channels_) {
      size_t lp = beginRecord(buf_, OP_CHANNEL);
      putU16(buf_, id);
      putU16(buf_, c.schemaId);
      putStr(buf_, c.topic);
      putStr(buf_, c.messageEncoding);
      putStrMap(buf_, c.metadata);
      endRecord(buf_, lp);
    }
    uint64_t length = static_cast<uint64_t>(buf_.size());
    flush(&summaryCrc);
    groups.push_back({OP_CHANNEL, start, length});
  }
  // Statistics (always present).
  {
    uint64_t start = position_;
    size_t lp = beginRecord(buf_, OP_STATISTICS);
    putU64(buf_, msgCount_);
    putU16(buf_, static_cast<uint16_t>(schemaCount_));
    putU32(buf_, channelCount_);
    putU32(buf_, 0); // attachmentCount
    putU32(buf_, metadataCount_);
    putU32(buf_, chunkCount_);
    putU64(buf_, msgStartTime_);
    putU64(buf_, msgEndTime_);
    // channelMessageCounts: Map<u16,u64> tuple array.
    size_t mapAt = buf_.size();
    putU32(buf_, 0);
    for (const auto &[ch, cnt] : channelMsgCounts_) {
      putU16(buf_, ch);
      putU64(buf_, cnt);
    }
    uint32_t mapLen = static_cast<uint32_t>(buf_.size() - mapAt - 4);
    for (int i = 0; i < 4; ++i)
      buf_[mapAt + i] = static_cast<uint8_t>(mapLen >> (8 * i));
    endRecord(buf_, lp);
    uint64_t length = static_cast<uint64_t>(buf_.size());
    flush(&summaryCrc);
    groups.push_back({OP_STATISTICS, start, length});
  }
  // Metadata index.
  {
    uint64_t start = position_;
    for (const auto &mi : metadataIndices_) {
      size_t lp = beginRecord(buf_, OP_METADATA_INDEX);
      putU64(buf_, mi.offset);
      putU64(buf_, mi.length);
      putStr(buf_, mi.name);
      endRecord(buf_, lp);
    }
    uint64_t length = static_cast<uint64_t>(buf_.size());
    flush(&summaryCrc);
    groups.push_back({OP_METADATA_INDEX, start, length});
  }
  // Chunk index.
  {
    uint64_t start = position_;
    for (const auto &ci : chunkIndices_) {
      size_t lp = beginRecord(buf_, OP_CHUNK_INDEX);
      putU64(buf_, ci.messageStartTime);
      putU64(buf_, ci.messageEndTime);
      putU64(buf_, ci.chunkStartOffset);
      putU64(buf_, ci.chunkLength);
      putU32(buf_, static_cast<uint32_t>(ci.messageIndexOffsets.size() * 10));
      for (const auto &[chId, off] : ci.messageIndexOffsets) {
        putU16(buf_, chId);
        putU64(buf_, off);
      }
      putU64(buf_, ci.messageIndexLength);
      putStr(buf_, ""); // compression
      putU64(buf_, ci.compressedSize);
      putU64(buf_, ci.uncompressedSize);
      endRecord(buf_, lp);
    }
    uint64_t length = static_cast<uint64_t>(buf_.size());
    flush(&summaryCrc);
    groups.push_back({OP_CHUNK_INDEX, start, length});
  }

  const uint64_t summaryOffsetStart = position_;
  const uint64_t summaryLength = summaryOffsetStart - summaryStart;

  // Summary offset records (skip zero-length groups).
  for (const Group &g : groups) {
    if (g.length == 0)
      continue;
    size_t lp = beginRecord(buf_, OP_SUMMARY_OFFSET);
    putU8(buf_, g.op);
    putU64(buf_, g.start);
    putU64(buf_, g.length);
    endRecord(buf_, lp);
  }
  // Fold the summary-offset bytes into the summary CRC, but do NOT emit yet —
  // the footer prefix must also be CRC'd, then footer + offsets are written.
  if (!buf_.empty())
    summaryCrc = crcUpdate(summaryCrc, buf_.data(), buf_.size());

  const uint64_t footerSummaryStart = summaryLength == 0 ? 0 : summaryStart;
  const uint64_t footerSummaryOffsetStart = summaryOffsetStart;

  // CRC the 25-byte footer prefix (opcode + length(20) + summaryStart +
  // summaryOffsetStart), exactly as @mcap/core does.
  {
    uint8_t prefix[25];
    prefix[0] = OP_FOOTER;
    uint64_t len = 20;
    for (int i = 0; i < 8; ++i)
      prefix[1 + i] = static_cast<uint8_t>(len >> (8 * i));
    for (int i = 0; i < 8; ++i)
      prefix[9 + i] = static_cast<uint8_t>(footerSummaryStart >> (8 * i));
    for (int i = 0; i < 8; ++i)
      prefix[17 + i] = static_cast<uint8_t>(footerSummaryOffsetStart >> (8 * i));
    summaryCrc = crcUpdate(summaryCrc, prefix, sizeof(prefix));
  }

  // Now append the footer + trailing magic AFTER the summary offset records
  // already sitting in buf_, and emit the whole tail in one write.
  putU8(buf_, OP_FOOTER);
  putU64(buf_, 20);
  putU64(buf_, footerSummaryStart);
  putU64(buf_, footerSummaryOffsetStart);
  putU32(buf_, summaryCrc);
  putBytes(buf_, kMagic, sizeof(kMagic));
  emit(buf_.data(), buf_.size(), nullptr);
  buf_.clear();

  if (fd_ >= 0) {
    ::close(fd_);
    fd_ = -1;
  }
  closed_ = true;
  return stats();
}

void McapWriter::abort() {
  if (fd_ >= 0) {
    ::close(fd_);
    fd_ = -1;
  }
  closed_ = true;
}

void McapWriter::addMetadata(const std::string &name, const MetaMap &metadata) {
  const uint64_t offset = position_;
  size_t lp = beginRecord(buf_, OP_METADATA);
  putStr(buf_, name);
  putStrMap(buf_, metadata);
  endRecord(buf_, lp);
  const uint64_t length = static_cast<uint64_t>(buf_.size());
  ++metadataCount_;
  metadataIndices_.push_back(MetadataIndexRec{name, offset, length});
  flush(&dataSectionCrc_);
}

} // namespace Record
