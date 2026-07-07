# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""Legacy dump → .fovea conversion: output must satisfy the §2b schema
contract exactly as the app writer does, so the converted file reads back
through the same FoveaReader path (frames, extras, metadata records)."""

from pathlib import Path

import pytest

from pyfovea import FoveaReader, LegacyRecording, convert_legacy

FIXTURES = Path(__file__).parent / "fixtures"


def test_convert_roundtrip(tmp_path: Path):
    out = tmp_path / "converted.fovea"
    counts = convert_legacy(FIXTURES / "legacy", out)
    assert counts == {"center": 1, "left-fovea": 2}

    with LegacyRecording(FIXTURES / "legacy") as legacy, FoveaReader(out) as reader:
        assert not reader.truncated
        assert sorted(reader.streams) == ["center", "left-fovea"]

        # channel metadata per §2b
        left = reader.streams["left-fovea"]
        assert left.dtype == "U16"
        assert left.shape == (2, 2)
        assert left.pixel_format == "Mono12p"
        assert left.significant_bits == 12

        # frames byte-identical to the legacy source, extras preserved
        for name, stream in legacy.streams.items():
            converted = reader.frames(name)
            assert len(converted) == len(stream)
            for src, dst in zip(stream, converted):
                assert dst.raw.tolist() == src.raw.tolist()
                assert dst.t == pytest.approx(src.timestamp)
                assert dst.extra == src.extra

        # session/finalize metadata carried over from manifest.json
        assert reader.session["timestamp"] == "2026-07-06T13:00:00.000Z"
        assert reader.session["durationSec"] == "1.75"


def test_convert_empty_dir_returns_no_counts(tmp_path: Path):
    src = tmp_path / "empty"
    src.mkdir()
    out = tmp_path / "empty.fovea"
    assert convert_legacy(src, out) == {}
    with FoveaReader(out) as reader:  # still a valid, finalized container
        assert reader.streams == {}
