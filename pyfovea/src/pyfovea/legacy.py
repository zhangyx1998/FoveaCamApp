# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""Legacy ``.stream``/``.meta`` dump reader.

Absorbs the read path of the retired per-dump ``stream-decoder.py``
template (its playback/ffmpeg UI is NOT ported — this package is a data
API + CLI): the JSONL meta sidecar with short keys (o/n/s/d/t/f/b/x), the
binary blob offsets, significant-bits scaling, and the affine extra.
Existing dumps and external tooling stay loadable forever through this
module; ``pyfovea convert`` re-encodes them as ``.fovea``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

import numpy as np

from .dtypes import NUMPY_DTYPE, significant_bits, to_display


@dataclass
class LegacyFrame:
    """One frame of a legacy stream — mirrors FrameMeta in stream-writer.ts."""

    offset: int  # o: byte offset in the .stream blob
    size: int  # n: length in bytes
    shape: tuple[int, ...]  # s
    dtype: str  # d
    timestamp: float  # t: seconds
    format: str  # f: pixel format
    bits: int = 0  # b: significant bit depth (0 = derive from format)
    extra: dict[str, Any] = field(default_factory=dict)  # x
    _blob: Any = None

    @property
    def raw(self) -> np.ndarray:
        self._blob.seek(self.offset)
        buffer = self._blob.read(self.size)
        if len(buffer) != self.size:
            raise ValueError(
                f"expected {self.size} bytes at offset {self.offset}, got {len(buffer)}"
            )
        return np.frombuffer(buffer, dtype=NUMPY_DTYPE[self.dtype]).reshape(self.shape)

    @property
    def display(self) -> np.ndarray:
        return to_display(self.raw, self.format, self.bits)

    @property
    def significant_bits(self) -> int:
        return significant_bits(self.format, self.bits)

    @property
    def affine(self) -> np.ndarray | None:
        a = self.extra.get("affine")
        return None if a is None else np.array(a, dtype=np.float64).reshape(3, 3)


class LegacyStream:
    """One legacy stream (``<name>.stream`` + ``<name>.meta``)."""

    def __init__(self, path: str | Path):
        base = str(path)
        for suffix in (".meta", ".stream"):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
        self.name = Path(base).name
        stream_path = Path(base + ".stream")
        meta_path = Path(base + ".meta")
        if not stream_path.exists():
            raise FileNotFoundError(f"stream file not found: {stream_path}")
        if not meta_path.exists():
            raise FileNotFoundError(f"meta file not found: {meta_path}")
        self.blob = stream_path.open("rb")
        self.frames: list[LegacyFrame] = []
        with meta_path.open("r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    m = json.loads(line)
                    frame = LegacyFrame(
                        offset=m["o"],
                        size=m["n"],
                        shape=tuple(m["s"]),
                        dtype=m["d"],
                        timestamp=m["t"],
                        format=m["f"],
                        bits=m.get("b", 0),
                        extra=m.get("x") or {},
                        _blob=self.blob,
                    )
                except (json.JSONDecodeError, KeyError, TypeError):
                    continue  # tolerate a torn trailing line (crash mid-write)
                self.frames.append(frame)

    def __len__(self) -> int:
        return len(self.frames)

    def __iter__(self) -> Iterator[LegacyFrame]:
        return iter(self.frames)

    def __getitem__(self, i: int) -> LegacyFrame:
        return self.frames[i]

    def close(self) -> None:
        self.blob.close()


class LegacyRecording:
    """A legacy dump directory: every ``*.meta``/``*.stream`` pair + the
    ``manifest.json`` written alongside them."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        if not self.path.is_dir():
            raise NotADirectoryError(f"not a legacy dump directory: {self.path}")
        self.manifest: dict[str, Any] = {}
        manifest_path = self.path / "manifest.json"
        if manifest_path.exists():
            self.manifest = json.loads(manifest_path.read_text())
        self.streams: dict[str, LegacyStream] = {}
        for meta_path in sorted(self.path.glob("*.meta")):
            if meta_path.with_suffix(".stream").exists():
                self.streams[meta_path.stem] = LegacyStream(meta_path)

    def __enter__(self) -> "LegacyRecording":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        for stream in self.streams.values():
            stream.close()
