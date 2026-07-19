# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""Mirrored constants for the ``.fovea``/``.fcap`` container schema."""

from __future__ import annotations

import json

FOVEA_EXTENSION = ".fovea"
FOVEA_PROFILE = "fovea"
FOVEA_LIBRARY = "FoveaCamApp"

TELEMETRY_TOPIC = "telemetry"
RAW_FRAME_SCHEMA_NAME = "fovea.raw_frame/v1"
TELEMETRY_SCHEMA_NAME = "fovea.frame_meta/v1"
JSON_SCHEMA_ENCODING = "jsonschema"
RAW_FRAME_MESSAGE_ENCODING = "x-fovea-raw"
TELEMETRY_MESSAGE_ENCODING = "json"

SESSION_METADATA_NAME = "fovea:session"
FINALIZE_METADATA_NAME = "fovea:finalize"

DEFAULT_CHUNK_BYTES = 256 * 1024
DEFAULT_MAX_QUEUED_FRAMES = 8

RAW_FRAME_SCHEMA_DATA = json.dumps(
    {
        "description": "Raw frame bytes exactly as captured (12p formats stay "
        "packed). Decode props are in the channel metadata."
    }
).encode()

TELEMETRY_SCHEMA_DATA = json.dumps(
    {
        "description": "Per-frame JSON metadata document: {stream, seq, t, "
        "...extras} — extras are the legacy .meta sidecar's `x` payload "
        "(volt/angle/affine). Correlate with the frame by stream+seq (or "
        "logTime)."
    }
).encode()

FRAME_METADATA_KEYS = (
    "dtype",
    "shape",
    "channels",
    "pixelFormat",
    "significantBits",
)

