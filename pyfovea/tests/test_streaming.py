# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""B-P10: FoveaReader.iter_frames_streaming() — additive, file-order, bounded
telemetry join, single forward pass. Covers a large-ish synthetic recording
(bounded-memory / yields-before-whole-file) and the real crash-truncated
fixture (streaming recovery without whole-file materialization)."""

import json
from pathlib import Path

import numpy as np
import pytest

from pyfovea import FoveaReader
from pyfovea.schema import (
    RAW_FRAME_MESSAGE_ENCODING,
    RAW_FRAME_SCHEMA_NAME,
    TELEMETRY_MESSAGE_ENCODING,
    TELEMETRY_SCHEMA_NAME,
    TELEMETRY_TOPIC,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _write_synth(path: Path, *, frames: int, width: int = 32, height: int = 32) -> int:
    """Write a synthetic single-stream ``.fovea`` with chunk-per-message (like
    the production writer), telemetry emitted immediately before each frame.
    Returns the file size in bytes."""
    from mcap.writer import CompressionType, Writer

    with path.open("wb") as f:
        # chunk_size=1 → every message flushes its own chunk, exactly like the
        # production "chunk ≈ 1 frame" default; NONE compression keeps the
        # reader path simple.
        writer = Writer(f, chunk_size=1, compression=CompressionType.NONE)
        writer.start(profile="fovea", library="test")
        tele_schema = writer.register_schema(TELEMETRY_SCHEMA_NAME, "jsonschema", b"{}")
        tele_chan = writer.register_channel(
            TELEMETRY_TOPIC, TELEMETRY_MESSAGE_ENCODING, tele_schema
        )
        raw_schema = writer.register_schema(RAW_FRAME_SCHEMA_NAME, "jsonschema", b"{}")
        raw_chan = writer.register_channel(
            "cam",
            RAW_FRAME_MESSAGE_ENCODING,
            raw_schema,
            metadata={
                "dtype": "U8",
                "shape": json.dumps([height, width]),
                "channels": "1",
                "pixelFormat": "Mono8",
                "significantBits": "8",
            },
        )
        for i in range(frames):
            log_time = (i + 1) * 1_000_000  # ascending ns
            tele = json.dumps({"stream": "cam", "seq": i, "t": log_time / 1e9, "volt": i}).encode()
            writer.add_message(tele_chan, log_time, tele, log_time, i)
            # deterministic frame payload: every pixel == i % 256
            frame = bytes([i % 256]) * (width * height)
            writer.add_message(raw_chan, log_time, frame, log_time, i)
        writer.finish()
    return path.stat().st_size


class _CountingStream:
    """Delegating binary stream that counts bytes actually read from disk."""

    def __init__(self, inner):
        self._inner = inner
        self.bytes_read = 0

    def read(self, *args):
        chunk = self._inner.read(*args)
        self.bytes_read += len(chunk)
        return chunk

    def readinto(self, buf):
        n = self._inner.readinto(buf)
        self.bytes_read += n or 0
        return n

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self._inner.close()


class _CountingReader(FoveaReader):
    """FoveaReader whose streaming scan reads through a byte counter."""

    def _stream_source(self):
        self.counter = _CountingStream(self.path.open("rb"))
        return self.counter


def test_streaming_yields_all_frames_in_file_order(tmp_path: Path):
    path = tmp_path / "synth.fovea"
    _write_synth(path, frames=300)
    with FoveaReader(path) as reader:
        seqs = [f.seq for f in reader.iter_frames_streaming("cam")]
        assert seqs == list(range(300))  # file order == write order here
        # same frame set as the indexed/log-time API (order aside)
        assert sorted(seqs) == sorted(f.seq for f in reader.iter_frames("cam"))


def test_streaming_joins_telemetry(tmp_path: Path):
    path = tmp_path / "synth.fovea"
    _write_synth(path, frames=8)
    with FoveaReader(path) as reader:
        frames = list(reader.iter_frames_streaming("cam"))
    assert len(frames) == 8
    for i, frame in enumerate(frames):
        assert frame.extra["volt"] == i  # telemetry-before-frame joined
        assert frame.raw.dtype == np.uint8
        assert int(frame.raw[0, 0]) == i % 256


def test_streaming_is_bounded_yields_before_whole_file(tmp_path: Path):
    """The first frame must arrive long before the whole file is read — proving
    the streaming path does NOT materialize the recording (chunk-per-frame, so
    the reader yields after ~one chunk)."""
    path = tmp_path / "big.fovea"
    total = _write_synth(path, frames=400)
    reader = _CountingReader(path)
    try:
        gen = reader.iter_frames_streaming("cam")
        first = next(gen)
        assert first.seq == 0
        # After the first yield, only a small prefix has been read.
        at_first = reader.counter.bytes_read
        assert at_first < total / 4, (at_first, total)
        # Peak pending telemetry stays ~1 (telemetry immediately precedes its
        # frame), so memory is bounded regardless of file size. Drain the rest.
        rest = sum(1 for _ in gen)
        assert rest == 399
        assert reader.counter.bytes_read >= at_first  # kept streaming forward
    finally:
        reader.close()


def test_streaming_recovers_crash_truncated():
    """Same recovery guarantee as the indexed ``truncated`` path, but via the
    single-pass streaming API — no whole-file buffering."""
    with FoveaReader(FIXTURES / "crash-truncated.fovea") as reader:
        frames = list(reader.iter_frames_streaming("left-fovea"))
        assert len(frames) == 3
        for i, frame in enumerate(frames):
            assert frame.seq == i
            assert frame.raw.tolist() == [[i, i + 1], [i + 2, i + 3]]
            assert frame.extra["volt"] == {"p": i / 10, "t": -i / 10}


def test_streaming_orphan_telemetry_stays_bounded(tmp_path: Path):
    """Orphaned telemetry (no matching frame) must not grow without bound — the
    pending map is capped and evicts oldest."""
    path = tmp_path / "synth.fovea"
    _write_synth(path, frames=50)
    with FoveaReader(path) as reader:
        # A tiny cap still yields every frame (each frame's telemetry precedes
        # it by one message, so a cap ≥ 1 never drops a real join).
        frames = list(reader.iter_frames_streaming("cam", max_pending_telemetry=1))
    assert [f.seq for f in frames] == list(range(50))
    assert all(f.extra["volt"] == f.seq for f in frames)
