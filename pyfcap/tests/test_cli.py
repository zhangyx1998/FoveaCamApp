# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""CLI entry points (inspect / export / convert) driven in-process via
``fcap.cli.main`` — same code path as the installed console script."""

import json
from pathlib import Path

import numpy as np
import pytest

from fcap import FoveaReader
from fcap.cli import main

FIXTURES = Path(__file__).parent / "fixtures"


def test_inspect_fovea(capsys: pytest.CaptureFixture):
    assert main(["inspect", str(FIXTURES / "tiny.fovea")]) == 0
    out = capsys.readouterr().out
    assert "MCAP container" in out
    assert "left-fovea: 2 frames, BayerRG12p [2, 2] U8 (12 bits)" in out
    assert "2 with telemetry" in out
    assert "timestamp=2026-07-06T12:00:00.000Z" in out


def test_inspect_truncated_flags_recovery(capsys: pytest.CaptureFixture):
    assert main(["inspect", str(FIXTURES / "crash-truncated.fovea")]) == 0
    out = capsys.readouterr().out
    assert "TRUNCATED" in out
    assert "left-fovea: 3 frames" in out


def test_inspect_legacy_dir(capsys: pytest.CaptureFixture):
    assert main(["inspect", str(FIXTURES / "legacy")]) == 0
    out = capsys.readouterr().out
    assert "legacy .stream/.meta dump" in out
    assert "left-fovea: 2 frames, Mono12p [2, 2] U16 (12 bits)" in out


def test_export_npy_with_extras(tmp_path: Path, capsys: pytest.CaptureFixture):
    assert main([
        "export", str(FIXTURES / "tiny.fovea"),
        "-s", "left-fovea", "-o", str(tmp_path),
    ]) == 0
    raw = np.load(tmp_path / "left-fovea-000000.npy")
    assert raw.tolist() == [[100, 2000], [3000, 4095]]
    extras = json.loads((tmp_path / "left-fovea-000000.json").read_text())
    assert extras["volt"] == {"p": 0.5, "t": -0.25}
    assert "exported 2 frames" in capsys.readouterr().out


def test_export_pgm_display_scaled(tmp_path: Path):
    assert main([
        "export", str(FIXTURES / "tiny.fovea"),
        "-s", "center", "-o", str(tmp_path), "-f", "pgm",
    ]) == 0
    body = (tmp_path / "center-000000.pgm").read_bytes()
    assert body.startswith(b"P5\n2 2\n255\n")
    assert body[-4:] == bytes([0, 1, 3, 255])  # 256/512/1024/65535 → 16-bit scaled


def test_convert_cli(tmp_path: Path, capsys: pytest.CaptureFixture):
    out_file = tmp_path / "out.fovea"
    assert main(["convert", str(FIXTURES / "legacy"), "-o", str(out_file)]) == 0
    assert "converted 3 frames" in capsys.readouterr().out
    with FoveaReader(out_file) as reader:
        assert sorted(reader.streams) == ["center", "left-fovea"]
