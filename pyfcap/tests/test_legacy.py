# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""Legacy .stream/.meta read path over a fixture dump written by the REAL
legacy writer (createLegacySink → StreamWriter — byte-identical to pre-B-5
recordings)."""

from pathlib import Path

import numpy as np
import pytest

from fcap import LegacyRecording, LegacyStream

FIXTURES = Path(__file__).parent / "fixtures" / "legacy"


def test_recording_directory_discovery():
    with LegacyRecording(FIXTURES) as rec:
        assert sorted(rec.streams) == ["center", "left-fovea"]
        assert rec.manifest["format"] == "FCRS"
        assert rec.manifest["timestamp"] == "2026-07-06T13:00:00.000Z"
        assert rec.manifest["duration"] == 1.75
        assert rec.manifest["streams"]["left-fovea"]["frames"] == 2


def test_stream_frames_and_extras():
    with LegacyRecording(FIXTURES) as rec:
        left = rec.streams["left-fovea"]
        assert len(left) == 2
        f0 = left[0]
        assert f0.dtype == "U16"
        assert f0.shape == (2, 2)
        assert f0.format == "Mono12p"
        assert f0.significant_bits == 12
        assert f0.timestamp == pytest.approx(1.0)
        assert f0.raw.tolist() == [[100, 2000], [3000, 4095]]
        assert f0.extra["volt"] == {"p": 0.5, "t": -0.25}
        assert f0.affine is not None and np.allclose(f0.affine, np.eye(3))
        # 12-bit scaling: 4095 → 255 even though the container is 16-bit
        assert f0.display[1, 1] == 255
        assert left[1].affine is None


def test_stream_opens_by_meta_stream_or_base_path():
    for path in (
        FIXTURES / "center.meta",
        FIXTURES / "center.stream",
        FIXTURES / "center",
    ):
        stream = LegacyStream(path)
        assert stream.name == "center"
        assert len(stream) == 1
        assert stream[0].raw.tolist() == [[9, 10], [11, 12]]
        stream.close()


def test_torn_trailing_meta_line_tolerated(tmp_path: Path):
    # simulate a crash mid-append: last JSONL line torn
    src_meta = (FIXTURES / "left-fovea.meta").read_text()
    (tmp_path / "torn.meta").write_text(src_meta + '{"o":16,"n":8,"s":[2,2')
    (tmp_path / "torn.stream").write_bytes((FIXTURES / "left-fovea.stream").read_bytes())
    stream = LegacyStream(tmp_path / "torn")
    assert len(stream) == 2  # torn line skipped, intact ones kept
    stream.close()


def test_missing_files_raise():
    with pytest.raises(FileNotFoundError):
        LegacyStream(FIXTURES / "missing")
    with pytest.raises(NotADirectoryError):
        LegacyRecording(FIXTURES / "left-fovea.meta")
