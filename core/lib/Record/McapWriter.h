// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// native-recorder: a HAND-ROLLED C++ MCAP writer emitting EXACTLY the subset the
// JS recorder path (`@mcap/core` driven from app/orchestrator/recorder/*) emits.
// The on-disk layout is byte-for-byte compatible with @mcap/core's default
// options (useChunks/useStatistics/useSummaryOffsets/repeatSchemas/repeat-
// Channels/useMessageIndex/useChunkIndex/useMetadataIndex all true, chunk
// compression ""), so the existing readers (viewer decode path, pyfcap,
// app/test/recorder.test.ts container-contract suite) accept a native-written
// file identically. Conformance is pinned by core/test/39-mcap-writer.ts, which
// drives this writer AND @mcap/core with identical inputs and byte-compares.
//
// WHY hand-rolled (drop diagnosis): the JS recorder made two full copies per
// frame (reused SHM read buffer -> fresh ArrayBuffer -> @mcap chunk builder),
// ran CRC32 in JS, framed a chunk per frame, and served every stream from ONE JS
// worker. This writer writes straight from a tapped frame buffer (one copy into
// the writer thread's chunk buffer), uses zlib crc32(), and is owned by a
// free-running native thread (RecorderStream) instead of a JS worker.
//
// The record grammar / CRC coverage is documented in
// docs/proposals/native-recorder.md and mirrored from @mcap/core's
// McapWriter.ts + McapRecordBuilder.ts + ChunkBuilder.ts.
//
// THREADING: this class is NOT internally synchronized. Exactly one thread (the
// RecorderStream writer thread, or the test driver) may call it. It owns a
// plain POSIX fd, writes sequentially (no seek-back — the summary/footer are
// appended at the end from in-memory index bookkeeping), and tracks its own
// byte position. A crash before end() leaves a footer-less container the
// streaming/re-index reader recovers (same crash-shape as the JS path).

#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace Record {

// Ordered key/value pairs for Channel/Metadata maps. Order is significant (it is
// the on-wire order and part of the byte contract); callers pass keys in the
// same order @mcap/core would iterate its `Map` (JS object insertion order).
using MetaMap = std::vector<std::pair<std::string, std::string>>;

class McapWriter {
public:
  struct Stats {
    uint64_t messageCount = 0;
    uint32_t chunkCount = 0;
    uint64_t byteCount = 0;
  };

  explicit McapWriter(uint64_t chunkSize);
  ~McapWriter();

  McapWriter(const McapWriter &) = delete;
  McapWriter &operator=(const McapWriter &) = delete;

  // Truncate/create `path`, write leading magic + Header. Throws
  // std::runtime_error on open/IO failure.
  void open(const std::string &path, const std::string &profile,
            const std::string &library);

  // Assign ids (schema from 1, channel from 0) exactly like @mcap/core. Records
  // are emitted lazily (into a chunk on first use) + repeated in the summary.
  uint16_t registerSchema(const std::string &name, const std::string &encoding,
                          const uint8_t *data, size_t len);
  uint16_t registerChannel(uint16_t schemaId, const std::string &topic,
                           const std::string &messageEncoding,
                           const MetaMap &metadata);

  // Append one message. Writes the channel's (and its schema's) record into the
  // open chunk on first use, records a message-index entry, and flushes the
  // chunk once it passes the chunk-size threshold (chunk >= threshold flushes).
  void addMessage(uint16_t channelId, uint32_t sequence, uint64_t logTime,
                  uint64_t publishTime, const uint8_t *data, size_t len);

  // Write a Metadata record directly into the data section (never inside a
  // chunk), immediately, and record a metadata-index entry for the summary.
  void addMetadata(const std::string &name, const MetaMap &metadata);

  // Flush the open chunk, DataEnd, summary (repeated schemas/channels,
  // statistics, metadata index, chunk index, summary offsets), footer, and
  // trailing magic; close the file. Idempotent-safe: returns the final stats.
  Stats end();

  // Crash-shape: close the fd with NO footer/summary (the buffered chunk is
  // lost). Only the streaming/re-index reader recovers such a file.
  void abort();

  uint64_t position() const { return position_; }
  Stats stats() const { return {msgCount_, chunkCount_, position_}; }

private:
  using Bytes = std::vector<uint8_t>;

  struct SchemaRec {
    std::string name;
    std::string encoding;
    Bytes data;
  };
  struct ChannelRec {
    uint16_t schemaId;
    std::string topic;
    std::string messageEncoding;
    MetaMap metadata;
  };
  // A per-chunk, per-channel message index (insertion order = order the channel
  // first gets a message within the chunk).
  struct ChanIndex {
    uint16_t channelId;
    std::vector<std::pair<uint64_t, uint64_t>> records; // (logTime, offset)
  };
  struct ChunkIndexRec {
    uint64_t messageStartTime;
    uint64_t messageEndTime;
    uint64_t chunkStartOffset;
    uint64_t chunkLength;
    std::vector<std::pair<uint16_t, uint64_t>> messageIndexOffsets;
    uint64_t messageIndexLength;
    uint64_t compressedSize;
    uint64_t uncompressedSize;
  };
  struct MetadataIndexRec {
    std::string name;
    uint64_t offset;
    uint64_t length;
  };

  // Emit `n` bytes to the fd, advancing position and (if `crc`) folding them
  // into that running CRC accumulator.
  void emit(const uint8_t *d, size_t n, uint32_t *crc);
  // Flush the scratch top-level record buffer `buf_` through emit().
  void flush(uint32_t *crc);
  void finalizeChunk();
  ChanIndex &chunkChannelIndex(uint16_t channelId);
  uint64_t &channelMessageCount(uint16_t channelId);

  int fd_ = -1;
  uint64_t position_ = 0;
  const uint64_t chunkSize_;
  bool closed_ = false;

  Bytes buf_;   // scratch for one top-level record (mirrors recordWriter.buffer)
  Bytes chunk_; // the open chunk's uncompressed inner records

  // Registry (id -> record). std::map keeps ids sorted == registration order
  // (ids are monotonic), which is the summary-repeat order @mcap/core uses.
  std::map<uint16_t, SchemaRec> schemas_;
  std::map<uint16_t, ChannelRec> channels_;
  std::unordered_map<uint16_t, bool> writtenSchema_;
  std::unordered_map<uint16_t, bool> writtenChannel_;
  uint16_t nextSchemaId_ = 1;
  uint16_t nextChannelId_ = 0;

  // Running data-section CRC (magic..before DataEnd), zlib-finalized form.
  uint32_t dataSectionCrc_ = 0;

  // Statistics.
  uint64_t msgCount_ = 0;
  uint32_t schemaCount_ = 0;
  uint32_t channelCount_ = 0;
  uint32_t metadataCount_ = 0;
  uint32_t chunkCount_ = 0;
  uint64_t msgStartTime_ = 0;
  uint64_t msgEndTime_ = 0;
  // channelMessageCounts — insertion order = order a channel first gets a
  // message (NOT id order), matching @mcap/core's Map iteration.
  std::vector<std::pair<uint16_t, uint64_t>> channelMsgCounts_;
  std::unordered_map<uint16_t, size_t> channelMsgCountIdx_;

  // Open-chunk bookkeeping.
  uint64_t chunkMsgStart_ = 0;
  uint64_t chunkMsgEnd_ = 0;
  size_t chunkNumMsgs_ = 0;
  std::vector<ChanIndex> chunkIndex_;
  std::unordered_map<uint16_t, size_t> chunkIndexLookup_;

  // Summary bookkeeping.
  std::vector<ChunkIndexRec> chunkIndices_;
  std::vector<MetadataIndexRec> metadataIndices_;
};

} // namespace Record
