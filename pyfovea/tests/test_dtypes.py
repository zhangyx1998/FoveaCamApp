# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""Decode primitives: 12p unpack (GenICam layout), payload dispatch,
significant-bits display scaling."""

import numpy as np
import pytest

from pyfovea import decode_payload, significant_bits, to_display, unpack_12p


def pack_12p(samples: list[int]) -> bytes:
    """Reference packer — mirrors the recorder/bench TS implementation."""
    out = bytearray()
    for i in range(0, len(samples) - 1, 2):
        a, b = samples[i] & 0xFFF, samples[i + 1] & 0xFFF
        out += bytes(((a & 0xFF), ((b & 0x0F) << 4) | (a >> 8), b >> 4))
    if len(samples) % 2:
        a = samples[-1] & 0xFFF
        out += bytes((a & 0xFF, a >> 8))
    return bytes(out)


def test_unpack_12p_roundtrip():
    values = [0, 1, 100, 2000, 3000, 4095]
    assert unpack_12p(pack_12p(values), len(values)).tolist() == values


def test_unpack_12p_odd_count():
    values = [4095, 0, 2048]
    assert unpack_12p(pack_12p(values), len(values)).tolist() == values


def test_unpack_12p_short_buffer_raises():
    with pytest.raises(ValueError, match="too short"):
        unpack_12p(b"\x00\x00", 4)


def test_decode_payload_unpacked_u16():
    data = np.array([1, 2, 3, 4], dtype=np.uint16).tobytes()
    out = decode_payload(data, "U16", (2, 2), "Mono16")
    assert out.dtype == np.uint16 and out.shape == (2, 2)
    assert out.ravel().tolist() == [1, 2, 3, 4]


def test_decode_payload_packed_12p():
    values = [100, 2000, 3000, 4095]
    out = decode_payload(pack_12p(values), "U8", (2, 2), "BayerRG12p")
    assert out.dtype == np.uint16  # 12-bit samples cannot stay U8
    assert out.ravel().tolist() == values


def test_decode_payload_size_mismatch_raises():
    with pytest.raises(ValueError, match="matches neither"):
        decode_payload(b"\x00" * 5, "U16", (2, 2), "Mono16")


def test_significant_bits_derivation():
    assert significant_bits("Mono12p") == 12
    assert significant_bits("BayerRG12p") == 12
    assert significant_bits("Mono16") == 16
    assert significant_bits("Mono8") == 8
    assert significant_bits("Mono16", declared=12) == 12  # sidecar wins


def test_to_display_scales_by_true_bit_depth():
    img12 = np.array([[0, 4095]], dtype=np.uint16)
    out = to_display(img12, "Mono12p")
    assert out.dtype == np.uint8
    assert out.tolist() == [[0, 255]]  # 4095 → 255, NOT 4095/65535 ≈ 15
    img16 = np.array([[0, 65535]], dtype=np.uint16)
    assert to_display(img16, "Mono16").tolist() == [[0, 255]]
    img8 = np.array([[7]], dtype=np.uint8)
    assert to_display(img8, "Mono8").tolist() == [[7]]  # untouched
