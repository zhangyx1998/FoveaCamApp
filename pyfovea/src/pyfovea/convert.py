# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""Convert a legacy ``.stream``/``.meta`` dump directory into a single
``.fovea`` container, emitting exactly the recorder-container.md §2b schema
the B-5 writer produces (channels + telemetry + fovea:session/:finalize
metadata), so every downstream consumer — this package, the viewer — sees
one format regardless of the dump's age.

Writer settings mirror B-5: no chunk compression (its bench-backed
default), chunk size 256 KiB (chunk ≈ 1 raw frame).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from mcap.writer import CompressionType, Writer

from .dtypes import significant_bits
from .fovea import TELEMETRY_TOPIC
from .legacy import LegacyRecording

CHUNK_BYTES = 256 * 1024

_RAW_SCHEMA = json.dumps(
    {
        "description": "Raw frame bytes exactly as captured (12p formats stay "
        "packed). Decode props are in the channel metadata."
    }
).encode()

_META_SCHEMA = json.dumps(
    {
        "description": "Per-frame JSON metadata document: {stream, seq, t, "
        "...extras} — extras are the legacy .meta sidecar's `x` payload "
        "(volt/angle/affine). Correlate with the frame by stream+seq (or "
        "logTime)."
    }
).encode()


def convert_legacy(src: str | Path, dst: str | Path) -> dict[str, int]:
    """Convert a legacy dump directory to ``dst`` (a ``.fovea`` path).
    Returns per-stream frame counts."""
    counts: dict[str, int] = {}
    with LegacyRecording(src) as rec:
        with open(dst, "wb") as out:
            writer = Writer(out, chunk_size=CHUNK_BYTES, compression=CompressionType.NONE)
            writer.start(profile="fovea", library="pyfovea (convert)")
            session: dict[str, str] = {"app": "pyfovea convert"}
            if rec.manifest.get("timestamp"):
                session["timestamp"] = str(rec.manifest["timestamp"])
            writer.add_metadata("fovea:session", session)

            meta_schema = writer.register_schema(
                name="fovea.frame_meta/v1", encoding="jsonschema", data=_META_SCHEMA
            )
            telemetry_id = writer.register_channel(
                topic=TELEMETRY_TOPIC,
                message_encoding="json",
                schema_id=meta_schema,
                metadata={},
            )
            raw_schema = writer.register_schema(
                name="fovea.raw_frame/v1", encoding="jsonschema", data=_RAW_SCHEMA
            )

            for name, stream in rec.streams.items():
                if len(stream) == 0:
                    continue
                first = stream[0]
                channel_id = writer.register_channel(
                    topic=name,
                    message_encoding="x-fovea-raw",
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
                writer.add_metadata("fovea:finalize", {"durationSec": str(duration)})
            writer.finish()
    return counts
