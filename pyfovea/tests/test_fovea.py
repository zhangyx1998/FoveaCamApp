# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""FoveaReader over fixtures written by the REAL app recorder (B-5 harness
— see fixtures/generate.ts): schema contract decode, telemetry join, 12p
unpack, and the streaming recovery path for a crash-truncated file."""

from pathlib import Path

import numpy as np
import pytest

from pyfovea import FoveaReader

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def tiny() -> FoveaReader:
    with FoveaReader(FIXTURES / "tiny.fovea") as reader:
        yield reader


def test_streams_and_channel_metadata(tiny: FoveaReader):
    assert not tiny.truncated
    assert sorted(tiny.streams) == ["center", "left-fovea"]  # telemetry not a stream
    left = tiny.streams["left-fovea"]
    assert left.dtype == "U8"  # packed bytes were typed U8 by the writer
    assert left.shape == (2, 2)
    assert left.pixel_format == "BayerRG12p"
    assert left.significant_bits == 12
    center = tiny.streams["center"]
    assert center.dtype == "U16"
    assert center.pixel_format == "Mono16"
    assert center.significant_bits == 16


def test_session_metadata(tiny: FoveaReader):
    assert tiny.session["timestamp"] == "2026-07-06T12:00:00.000Z"
    assert tiny.session["durationSec"] == "2"


def test_12p_frames_unpack_with_extras(tiny: FoveaReader):
    frames = tiny.frames("left-fovea")
    assert len(frames) == 2
    f0 = frames[0]
    assert f0.seq == 0
    assert f0.t == pytest.approx(1.0)
    assert f0.raw.dtype == np.uint16
    assert f0.raw.tolist() == [[100, 2000], [3000, 4095]]
    # telemetry join (volt/angle/affine — written per-frame by the recorder)
    assert f0.extra["volt"] == {"p": 0.5, "t": -0.25}
    assert f0.extra["angle"] == {"x": 0.01, "y": -0.02}
    assert f0.affine is not None and f0.affine.shape == (3, 3)
    assert f0.affine[0, 2] == pytest.approx(0.5)
    assert frames[1].raw.tolist() == [[0, 1], [2048, 4094]]
    # display scaling by TRUE bit depth: 4095 → 255
    assert f0.display[1, 1] == 255


def test_mono16_frames_no_extras(tiny: FoveaReader):
    frames = tiny.frames("center")
    assert len(frames) == 2
    assert frames[0].raw.tolist() == [[256, 512], [1024, 65535]]
    assert frames[0].extra == {}  # empty extras were skipped by the writer
    assert frames[0].t == pytest.approx(1.25)


def test_iter_all_streams_in_log_time_order(tiny: FoveaReader):
    times = [f.t for f in tiny.iter_frames()]
    assert times == sorted(times)
    assert len(times) == 4


def test_crash_truncated_recovery():
    with FoveaReader(FIXTURES / "crash-truncated.fovea") as reader:
        assert reader.truncated
        frames = reader.frames("left-fovea")
        # 6 frames were written chunk-per-message; the 60% cut leaves the
        # first 3 complete frame chunks (fixture is deterministic).
        assert len(frames) == 3
        for i, frame in enumerate(frames):
            assert frame.seq == i
            assert frame.raw.tolist() == [[i, i + 1], [i + 2, i + 3]]
            # telemetry docs precede their frame on the write chain, so the
            # single forward pass joined them even without an index
            assert frame.extra["volt"] == {"p": i / 10, "t": -i / 10}
        # session metadata was written at start → survives truncation
        assert reader.session.get("timestamp") == "2026-07-06T12:30:00.000Z"
        # duration lives in fovea:finalize (written at end) → lost, absent
        assert "durationSec" not in reader.session


def test_missing_file_raises():
    with pytest.raises(FileNotFoundError):
        FoveaReader(FIXTURES / "nope.fovea")
