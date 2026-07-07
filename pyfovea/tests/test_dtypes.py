# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""Decode primitives: 12p unpack (GenICam layout), payload dispatch,
significant-bits display scaling."""

import json
from pathlib import Path

import numpy as np
import pytest

from pyfovea import decode_payload, significant_bits, to_display, unpack_12p


ROOT = Path(__file__).resolve().parents[2]
CODEC_FIXTURE = ROOT / "docs" / "schema" / "codec" / "12p-vectors.json"


def vectors():
    return json.loads(CODEC_FIXTURE.read_text())["vectors"]


def test_unpack_12p_roundtrip():
    for vector in vectors():
        packed = bytes.fromhex(vector["packedHex"])
        assert unpack_12p(packed, len(vector["samples"])).tolist() == vector["samples"]


def test_unpack_12p_odd_count():
    vector = next(v for v in vectors() if v["name"] == "odd-trailing")
    assert unpack_12p(bytes.fromhex(vector["packedHex"]), 3).tolist() == vector["samples"]


def test_unpack_12p_short_buffer_raises():
    with pytest.raises(ValueError, match="too short"):
        unpack_12p(b"\x00\x00", 4)


def test_decode_payload_unpacked_u16():
    data = np.array([1, 2, 3, 4], dtype=np.uint16).tobytes()
    out = decode_payload(data, "U16", (2, 2), "Mono16")
    assert out.dtype == np.uint16 and out.shape == (2, 2)
    assert out.ravel().tolist() == [1, 2, 3, 4]


def test_decode_payload_packed_12p():
    vector = next(v for v in vectors() if v["name"] == "nibbles")
    out = decode_payload(bytes.fromhex(vector["packedHex"]), "U8", (2, 2), "BayerRG12p")
    assert out.dtype == np.uint16  # 12-bit samples cannot stay U8
    assert out.ravel().tolist() == vector["samples"]


def test_decode_payload_size_mismatch_raises():
    with pytest.raises(ValueError, match="matches neither"):
        decode_payload(b"\x00" * 5, "U16", (2, 2), "Mono16")


def test_significant_bits_derivation():
    assert significant_bits("Mono12p") == 12
    assert significant_bits("BayerRG12p") == 12
    assert significant_bits("Mono16") == 16
    assert significant_bits("Mono8") == 8
    assert significant_bits("Mono16", declared=12) == 12  # sidecar wins
    assert significant_bits("LegacyMono16") == 16
    assert significant_bits("LegacyBayerRG12p") == 12
    assert significant_bits("LegacyMono") == 8


def test_to_display_scales_by_true_bit_depth():
    img12 = np.array([[0, 4095]], dtype=np.uint16)
    out = to_display(img12, "Mono12p")
    assert out.dtype == np.uint8
    assert out.tolist() == [[0, 255]]  # 4095 → 255, NOT 4095/65535 ≈ 15
    img16 = np.array([[0, 65535]], dtype=np.uint16)
    assert to_display(img16, "Mono16").tolist() == [[0, 255]]
    img8 = np.array([[7]], dtype=np.uint8)
    assert to_display(img8, "Mono8").tolist() == [[7]]  # untouched
