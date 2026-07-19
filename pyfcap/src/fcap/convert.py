# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""Convert a legacy ``.stream``/``.meta`` dump directory into a single
``.fcap`` container, emitting exactly the .fcap schema the recorder's writer
produces (channels + telemetry + fovea:session/:finalize metadata), so every
downstream consumer — this package, the viewer — sees one format regardless
of the dump's age.

Writer settings mirror the recorder: no chunk compression (the bench-backed
default), chunk size 256 KiB (chunk ≈ 1 raw frame).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from mcap.writer import CompressionType, Writer

from .dtypes import significant_bits
from .legacy import LegacyRecording
from .schema import (
    DEFAULT_CHUNK_BYTES,
    FINALIZE_METADATA_NAME,
    FOVEA_PROFILE,
    RAW_FRAME_MESSAGE_ENCODING,
    RAW_FRAME_SCHEMA_DATA,
    RAW_FRAME_SCHEMA_NAME,
    SESSION_METADATA_NAME,
    TELEMETRY_MESSAGE_ENCODING,
    TELEMETRY_SCHEMA_DATA,
    TELEMETRY_SCHEMA_NAME,
    TELEMETRY_TOPIC,
)


def convert_legacy(src: str | Path, dst: str | Path) -> dict[str, int]:
    """Convert a legacy dump directory to ``dst`` (a ``.fcap`` path).
    Returns per-stream frame counts."""
    counts: dict[str, int] = {}
    with LegacyRecording(src) as rec:
        with open(dst, "wb") as out:
            writer = Writer(out, chunk_size=DEFAULT_CHUNK_BYTES, compression=CompressionType.NONE)
            writer.start(profile=FOVEA_PROFILE, library="fcap (convert)")
            session: dict[str, str] = {"app": "fcap convert"}
            if rec.manifest.get("timestamp"):
                session["timestamp"] = str(rec.manifest["timestamp"])
            writer.add_metadata(SESSION_METADATA_NAME, session)

            meta_schema = writer.register_schema(
                name=TELEMETRY_SCHEMA_NAME, encoding="jsonschema", data=TELEMETRY_SCHEMA_DATA
            )
            telemetry_id = writer.register_channel(
                topic=TELEMETRY_TOPIC,
                message_encoding=TELEMETRY_MESSAGE_ENCODING,
                schema_id=meta_schema,
                metadata={},
            )
            raw_schema = writer.register_schema(
                name=RAW_FRAME_SCHEMA_NAME, encoding="jsonschema", data=RAW_FRAME_SCHEMA_DATA
            )

            for name, stream in rec.streams.items():
                if len(stream) == 0:
                    continue
                first = stream[0]
                channel_id = writer.register_channel(
                    topic=name,
                    message_encoding=RAW_FRAME_MESSAGE_ENCODING,
                    schema_id=raw_schema,
                    metadata={
                        "dtype": first.dtype,
                        "shape": json.dumps(list(first.shape)),
                        "channels": str(first.shape[2] if len(first.shape) > 2 else 1),
                        "pixelFormat": first.format,
                        "significantBits": str(significant_bits(first.format, first.bits)),
                    },
                )
                for seq, frame in enumerate(stream):
                    log_time = int(round(frame.timestamp * 1e9))
                    if frame.extra:
                        writer.add_message(
                            channel_id=telemetry_id,
                            log_time=log_time,
                            publish_time=log_time,
                            sequence=seq,
                            data=json.dumps(
                                {"stream": name, "seq": seq, "t": frame.timestamp, **frame.extra}
                            ).encode(),
                        )
                    writer.add_message(
                        channel_id=channel_id,
                        log_time=log_time,
                        publish_time=log_time,
                        sequence=seq,
                        data=frame.raw.tobytes(),
                    )
                counts[name] = len(stream)

            duration = rec.manifest.get("duration")
            if duration is not None and not (
                isinstance(duration, float) and math.isnan(duration)
            ):
                writer.add_metadata(FINALIZE_METADATA_NAME, {"durationSec": str(duration)})
            writer.finish()
    return counts
