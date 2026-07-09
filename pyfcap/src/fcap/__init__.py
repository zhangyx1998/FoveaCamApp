# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""fcap — reader and CLI for FoveaCam Duo recordings.

Two on-disk formats, one API surface:

- ``.fcap`` single-file containers (standard MCAP inside; the
  recorder-container.md §2b schema) via :class:`FoveaReader` — including
  the streaming recovery path for crash-truncated (footerless) files.
  Legacy ``.fovea`` files use the identical container and read the same
  way (the reader is extension-agnostic);
- legacy ``.stream``/``.meta`` dump directories via
  :class:`LegacyRecording` / :class:`LegacyStream`, absorbing the retired
  per-dump ``stream-decoder.py`` template's decode logic;
- :func:`convert_legacy` re-encodes a legacy dump as ``.fcap``.

Distribution/import name ``fcap``; PyPI publishing is user-gated (check
name availability at publish time).
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
from .fovea import FoveaFrame, FoveaReader, StreamInfo, XY
from .legacy import LegacyFrame, LegacyRecording, LegacyStream
from .schema import TELEMETRY_TOPIC

__version__ = "0.1.0"

__all__ = [
    "FoveaReader",
    "FoveaFrame",
    "StreamInfo",
    "XY",
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
