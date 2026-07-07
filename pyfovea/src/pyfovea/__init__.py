# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""pyfovea — reader and CLI for FoveaCam Duo recordings.

Two on-disk formats, one API surface:

- ``.fovea`` single-file containers (standard MCAP inside; the
  recorder-container.md §2b schema) via :class:`FoveaReader` — including
  the streaming recovery path for crash-truncated (footerless) files;
- legacy ``.stream``/``.meta`` dump directories via
  :class:`LegacyRecording` / :class:`LegacyStream`, absorbing the retired
  per-dump ``stream-decoder.py`` template's decode logic;
- :func:`convert_legacy` re-encodes a legacy dump as ``.fovea``.

The package name is a placeholder — the user may rename it before any
PyPI release (publishing is user-gated).
"""

from .convert import convert_legacy
from .dtypes import (
    NUMPY_DTYPE,
    decode_payload,
    demosaic,
    significant_bits,
    to_display,
    unpack_12p,
)
from .fovea import TELEMETRY_TOPIC, FoveaFrame, FoveaReader, StreamInfo
from .legacy import LegacyFrame, LegacyRecording, LegacyStream

__version__ = "0.1.0"

__all__ = [
    "FoveaReader",
    "FoveaFrame",
    "StreamInfo",
    "TELEMETRY_TOPIC",
    "LegacyRecording",
    "LegacyStream",
    "LegacyFrame",
    "convert_legacy",
    "NUMPY_DTYPE",
    "decode_payload",
    "demosaic",
    "significant_bits",
    "to_display",
    "unpack_12p",
    "__version__",
]
