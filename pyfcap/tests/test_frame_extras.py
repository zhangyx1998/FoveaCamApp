# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""B-14 (WS4 4b, decoder half): FoveaReader exposes the recorder's
``RecordedFrameExtras`` (app/orchestrator/recorder/metadata.ts — the fixed
contract) as typed per-frame accessors, additive/optional.

Fixtures are synthesized here (no committed binary needed). The load-bearing
byte is the per-frame ``telemetry`` JSON document; the with-extras frame's doc
is EXACTLY (note the literal dotted keys, not nested objects):

  {"stream":"cam","seq":0,"t":1.0,"frame_id":42,
   "volt":{"x":1.25,"y":-0.5},"volt.unit":"volt","volt.source":"fin-averaged",
   "angle":{"x":0.01,"y":-0.02},"affine":[1,0,0.5,0,1,-0.25,0,0,1]}

The without-extras frame has NO telemetry doc at all (older files / free-run).
"""

import json
from pathlib import Path

import pytest

from fcap import FoveaReader, XY

RAW_META = {
    "dtype": "U8",
    "shape": "[2, 2]",
    "channels": "1",
    "pixelFormat": "Mono8",
    "significantBits": "8",
}

# The exact RecordedFrameExtras a recorder frame from a CMD_FRAME capture carries
# (mirrors frameVoltageExtras(42, {x:1.25, y:-0.5}) + pass-through angle/affine).
EXTRAS = {
    "frame_id": 42,
    "volt": {"x": 1.25, "y": -0.5},
    "volt.unit": "volt",
    "volt.source": "fin-averaged",
    "angle": {"x": 0.01, "y": -0.02},
    "affine": [1, 0, 0.5, 0, 1, -0.25, 0, 0, 1],
}


def _write_fovea(path: Path, *, with_extras: bool) -> None:
    from mcap.writer import CompressionType, Writer

    with path.open("wb") as f:
        writer = Writer(f, compression=CompressionType.NONE)
        writer.start(profile="fovea", library="test")
        tele_schema = writer.register_schema("fovea.frame_meta/v1", "jsonschema", b"{}")
        tele_chan = writer.register_channel("telemetry", "json", tele_schema)
        raw_schema = writer.register_schema("fovea.raw_frame/v1", "jsonschema", b"{}")
        raw_chan = writer.register_channel("cam", "x-fovea-raw", raw_schema, metadata=RAW_META)
        log_time = 1_000_000_000  # 1.0 s in ns
        if with_extras:
            doc = {"stream": "cam", "seq": 0, "t": 1.0, **EXTRAS}
            writer.add_message(tele_chan, log_time, json.dumps(doc).encode(), log_time, 0)
        writer.add_message(raw_chan, log_time, bytes([1, 2, 3, 4]), log_time, 0)
        writer.finish()


@pytest.fixture
def with_extras(tmp_path: Path) -> Path:
    path = tmp_path / "extras.fovea"
    _write_fovea(path, with_extras=True)
    return path


@pytest.fixture
def without_extras(tmp_path: Path) -> Path:
    path = tmp_path / "bare.fovea"
    _write_fovea(path, with_extras=False)
    return path


def test_reads_recorded_frame_extras(with_extras: Path):
    with FoveaReader(with_extras) as reader:
        frame = reader.frames("cam")[0]
    assert frame.frame_id == 42
    assert frame.volt == XY(1.25, -0.5)
    assert isinstance(frame.volt, XY) and frame.volt.x == 1.25 and frame.volt.y == -0.5
    assert frame.volt_unit == "volt"
    assert frame.volt_source == "fin-averaged"
    assert frame.angle == XY(0.01, -0.02)
    assert frame.affine is not None and frame.affine.shape == (3, 3)
    assert frame.affine[0, 2] == pytest.approx(0.5)
    # raw payload still decodes alongside the extras
    assert frame.raw.tolist() == [[1, 2], [3, 4]]


def test_extras_exposed_on_streaming_path(with_extras: Path):
    # iter_frames_streaming (B-P10) must surface the same typed extras.
    with FoveaReader(with_extras) as reader:
        frame = next(reader.iter_frames_streaming("cam"))
    assert frame.frame_id == 42
    assert frame.volt == XY(1.25, -0.5)
    assert frame.volt_source == "fin-averaged"


def test_without_extras_is_backward_compatible(without_extras: Path):
    # Older files / free-running frames carry no telemetry doc — every accessor
    # is None and the frame still decodes.
    with FoveaReader(without_extras) as reader:
        frame = reader.frames("cam")[0]
    assert frame.extra == {}
    assert frame.frame_id is None
    assert frame.volt is None
    assert frame.volt_unit is None
    assert frame.volt_source is None
    assert frame.angle is None
    assert frame.affine is None
    assert frame.raw.tolist() == [[1, 2], [3, 4]]


def test_partial_extras_absent_fields_are_none(tmp_path: Path):
    # A telemetry doc with only some keys → present ones decode, missing → None
    # (additive/optional per field, not all-or-nothing).
    path = tmp_path / "partial.fovea"
    from mcap.writer import CompressionType, Writer

    with path.open("wb") as f:
        w = Writer(f, compression=CompressionType.NONE)
        w.start(profile="fovea", library="test")
        ts = w.register_schema("fovea.frame_meta/v1", "jsonschema", b"{}")
        tc = w.register_channel("telemetry", "json", ts)
        rs = w.register_schema("fovea.raw_frame/v1", "jsonschema", b"{}")
        rc = w.register_channel("cam", "x-fovea-raw", rs, metadata=RAW_META)
        doc = {"stream": "cam", "seq": 0, "t": 1.0, "frame_id": 7}  # volt/angle absent
        w.add_message(tc, 1_000_000_000, json.dumps(doc).encode(), 1_000_000_000, 0)
        w.add_message(rc, 1_000_000_000, bytes([1, 2, 3, 4]), 1_000_000_000, 0)
        w.finish()

    with FoveaReader(path) as reader:
        frame = reader.frames("cam")[0]
    assert frame.frame_id == 7
    assert frame.volt is None
    assert frame.volt_source is None
    assert frame.angle is None


def _write_with_telemetry(path: Path, tele_bytes: bytes) -> None:
    """One raw frame + one telemetry message carrying arbitrary `tele_bytes`
    (may be malformed JSON — exercises the reader's tolerant parse)."""
    from mcap.writer import CompressionType, Writer

    with path.open("wb") as f:
        w = Writer(f, compression=CompressionType.NONE)
        w.start(profile="fovea", library="test")
        ts = w.register_schema("fovea.frame_meta/v1", "jsonschema", b"{}")
        tc = w.register_channel("telemetry", "json", ts)
        rs = w.register_schema("fovea.raw_frame/v1", "jsonschema", b"{}")
        rc = w.register_channel("cam", "x-fovea-raw", rs, metadata=RAW_META)
        w.add_message(tc, 1_000_000_000, tele_bytes, 1_000_000_000, 0)
        w.add_message(rc, 1_000_000_000, bytes([1, 2, 3, 4]), 1_000_000_000, 0)
        w.finish()


def _frame_with_doc(tmp_path: Path, doc: dict) -> "FoveaReader":
    path = tmp_path / "doc.fovea"
    _write_with_telemetry(path, json.dumps(doc).encode())
    return FoveaReader(path)


@pytest.mark.parametrize(
    "volt_value",
    [42, "1.25", [1.25, -0.5], {"x": 1.0}, {"y": 1.0}, {}, None],
    ids=["number", "string", "list", "only-x", "only-y", "empty", "null"],
)
def test_malformed_volt_decodes_to_none(tmp_path: Path, volt_value):
    # `.volt` requires a dict with both x and y (the RecordedFrameExtras {x,y}
    # contract); anything else → None (never raises), and the raw value is still
    # reachable via `.extra`.
    with _frame_with_doc(tmp_path, {"stream": "cam", "seq": 0, "t": 1.0, "volt": volt_value}) as r:
        frame = r.frames("cam")[0]
    assert frame.volt is None
    assert frame.extra.get("volt") == volt_value


def test_legacy_pt_volt_shape_is_none_but_raw_preserved(tmp_path: Path):
    # The legacy B-5 `{p, t}` volt shape is NOT the {x,y} RecordedFrameExtras
    # contract, so `.volt` returns None — but `.extra["volt"]` still exposes the
    # legacy payload (documented in B-14; not a schema conflict).
    with _frame_with_doc(tmp_path, {"stream": "cam", "seq": 0, "t": 1.0, "volt": {"p": 0.5, "t": -0.25}}) as r:
        frame = r.frames("cam")[0]
    assert frame.volt is None
    assert frame.extra["volt"] == {"p": 0.5, "t": -0.25}


def test_malformed_telemetry_doc_is_skipped_not_fatal(tmp_path: Path):
    # A torn / non-JSON telemetry doc must be dropped tolerantly — the frame
    # still decodes with empty extras (no join, no crash).
    path = tmp_path / "torn.fovea"
    _write_with_telemetry(path, b"{not valid json")
    with FoveaReader(path) as r:
        frame = r.frames("cam")[0]
    assert frame.extra == {}
    assert frame.frame_id is None and frame.volt is None
    assert frame.raw.tolist() == [[1, 2], [3, 4]]


def test_frame_id_coerced_to_int(tmp_path: Path):
    # frame_id arrives as JSON number; a stringified value still coerces to int.
    with _frame_with_doc(tmp_path, {"stream": "cam", "seq": 0, "t": 1.0, "frame_id": "99"}) as r:
        frame = r.frames("cam")[0]
    assert frame.frame_id == 99 and isinstance(frame.frame_id, int)
