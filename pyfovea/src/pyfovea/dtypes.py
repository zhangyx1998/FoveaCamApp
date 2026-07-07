# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""Payload decoding primitives shared by the .fovea and legacy readers.

Ports the decode logic of the retired per-dump ``stream-decoder.py``
template: dtype mapping (must match ``app/lib/util/dtype.ts``),
significant-bits scaling (12-bit data lives 0..4095 in a 16-bit container —
scale by 4095, not 65535), plus the GenICam ``*12p`` unpack (3 bytes -> 2
pixels) for frames recorded packed, per the recorder-container.md §2b
contract ("12-bit-packed formats STAY packed").
"""

from __future__ import annotations

import math

import numpy as np

# Pixel-format facts come from the generated registry mirror
# (docs/schema/pixel-formats.ts → pixel_formats.py) so the list can't drift from
# the C++/TS tables. BAYER_PATTERNS is re-exported here for backward-compatible
# imports.
from .pixel_formats import BAYER_PATTERNS, pixel_format_spec

#: Short dtype name -> numpy dtype. Must match ``Dtype`` in
#: ``app/lib/util/dtype.ts``.
NUMPY_DTYPE: dict[str, np.dtype] = {
    "U8": np.dtype("uint8"),
    "I8": np.dtype("int8"),
    "U16": np.dtype("uint16"),
    "I16": np.dtype("int16"),
    "U32": np.dtype("uint32"),
    "I32": np.dtype("int32"),
    "F32": np.dtype("float32"),
    "F64": np.dtype("float64"),
    "U64": np.dtype("uint64"),
    "I64": np.dtype("int64"),
}


def significant_bits(fmt: str, declared: int = 0) -> int:
    """Effective bit depth of pixel data. Prefer the declared value (channel
    metadata / meta sidecar); otherwise use the registry for known formats and
    keep suffix derivation for unknown legacy names."""
    if declared:
        return declared
    spec = pixel_format_spec(fmt)
    if spec is not None:
        return spec.significant_bits
    if fmt.endswith("12p"):
        return 12
    if fmt.endswith("16"):
        return 16
    return 8


def unpack_12p(buffer: bytes | np.ndarray, count: int) -> np.ndarray:
    """Unpack GenICam ``*12p`` bytes (2 pixels / 3 bytes) into uint16.

    Layout (per 3-byte group, pixels a and b):
      byte0 = a & 0xff
      byte1 = ((b & 0x0f) << 4) | (a >> 8)
      byte2 = b >> 4
    """
    raw = np.frombuffer(buffer, dtype=np.uint8) if not isinstance(buffer, np.ndarray) else buffer
    groups = count // 2
    need = groups * 3 + (2 if count % 2 else 0)
    if len(raw) < need:
        raise ValueError(f"12p buffer too short: {len(raw)} bytes for {count} pixels")
    out = np.empty(count, dtype=np.uint16)
    trip = raw[: groups * 3].reshape(groups, 3).astype(np.uint16)
    out[0 : groups * 2 : 2] = trip[:, 0] | ((trip[:, 1] & 0x0F) << 8)
    out[1 : groups * 2 : 2] = (trip[:, 2] << 4) | (trip[:, 1] >> 4)
    if count % 2:  # trailing lone pixel (2 bytes)
        a = int(raw[groups * 3]) | ((int(raw[groups * 3 + 1]) & 0x0F) << 8)
        out[-1] = a
    return out


def decode_payload(
    data: bytes,
    dtype: str,
    shape: tuple[int, ...],
    pixel_format: str,
) -> np.ndarray:
    """Decode one raw frame payload into an ndarray of ``shape``.

    Handles both storage variants the recorder may produce for 12-bit
    formats: already-unpacked 16-bit containers (byte length matches
    ``shape`` x dtype itemsize) and packed ``*12p`` payloads (1.5 bytes per
    pixel — unpacked here to uint16 regardless of the declared dtype, since
    12-bit samples do not fit the U8 the packed buffer was typed as).
    """
    np_dtype = NUMPY_DTYPE[dtype]
    count = math.prod(shape)
    expected = count * np_dtype.itemsize
    if len(data) == expected:
        return np.frombuffer(data, dtype=np_dtype).reshape(shape)
    if pixel_format.endswith("12p") and len(data) == math.ceil(count * 1.5):
        return unpack_12p(data, count).reshape(shape)
    raise ValueError(
        f"payload size {len(data)} matches neither {expected} ({dtype} x {shape})"
        f" nor packed 12p ({math.ceil(count * 1.5)}) for format {pixel_format}"
    )


def to_display(img: np.ndarray, pixel_format: str, bits: int = 0) -> np.ndarray:
    """Scale a decoded frame to uint8 using its TRUE bit depth, so 12-bit
    data (0..4095 in a 16-bit container) is not rendered ~16x too dark.
    Ported from stream-decoder.py's normalization step. Demosaic is NOT
    applied here — see :func:`demosaic` (optional, needs cv2)."""
    if img.dtype == np.uint8:
        return img
    max_val = (1 << significant_bits(pixel_format, bits)) - 1
    return (img.astype(np.uint32) * 255 // max_val).clip(0, 255).astype(np.uint8)


def demosaic(img: np.ndarray, pixel_format: str) -> np.ndarray:
    """Debayer a raw frame to RGB (requires the optional ``cv`` extra)."""
    pattern = next((p for p in BAYER_PATTERNS if pixel_format.startswith(p)), None)
    if pattern is None:
        return img
    try:
        import cv2
    except ImportError as e:  # pragma: no cover - depends on optional extra
        raise ImportError(
            "demosaic requires OpenCV — install with `pip install pyfovea[cv]`"
        ) from e
    return cv2.cvtColor(img, getattr(cv2, f"COLOR_{pattern}2RGB"))
