# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""Typed reader for ``.fovea`` recordings (standard MCAP inside).

Implements the recorder-container.md §2b schema contract:

- one channel per recorded stream, ``messageEncoding: "x-fovea-raw"`` —
  message bytes are the raw frame exactly as captured (12-bit-packed
  formats stay packed; unpacked here on decode);
- channel metadata carries the static decode props: ``dtype``, ``shape``,
  ``pixelFormat``, ``significantBits``, ``channels``;
- one ``telemetry`` channel of per-frame JSON documents ({stream, seq, t,
  ...extras}) — the legacy sidecar's ``x`` payload, joined onto frames by
  (stream, seq);
- timestamps are nanoseconds, monotonic from process start; the absolute
  wall-clock anchor lives in the ``fovea:session`` metadata record.

Crash tolerance (a MUST per §2b): a crash-truncated file has no footer, so
the indexed/seeking path fails — this reader falls back to a sequential
streaming scan that recovers every complete record before the truncation
point (the B-4 finding: loss window ≈ 1 message with the writer's
chunk-per-frame default). ``FoveaReader.truncated`` reports which path was
taken. The B-5 writer posts a frame's telemetry document *before* the frame
on the same worker chain, so a single forward pass always sees extras
before the frame they belong to — the fallback join needs no second pass.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any, Iterator, NamedTuple

import numpy as np
from mcap.exceptions import McapError
from mcap.reader import NonSeekingReader, SeekingReader
from mcap.records import Channel, Message

from .dtypes import decode_payload, significant_bits, to_display
from .schema import TELEMETRY_TOPIC


@dataclass(frozen=True)
class StreamInfo:
    """Static decode props of one recorded stream (from channel metadata)."""

    name: str
    dtype: str
    shape: tuple[int, ...]
    channels: int
    pixel_format: str
    significant_bits: int


class XY(NamedTuple):
    """A 2-axis reading ``{x, y}`` — a mirror voltage or angle from the
    per-frame telemetry extras."""

    x: float
    y: float


@dataclass
class FoveaFrame:
    """One recorded frame + its (optional) telemetry extras."""

    stream: StreamInfo
    seq: int
    log_time: int  # nanoseconds (monotonic, session-relative epoch)
    data: bytes
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def t(self) -> float:
        """Timestamp in seconds (same clock the legacy writer used)."""
        return self.log_time / 1e9

    @property
    def raw(self) -> np.ndarray:
        """Decoded frame — 12p payloads unpacked to uint16, else zero-copy."""
        return decode_payload(
            self.data, self.stream.dtype, self.stream.shape, self.stream.pixel_format
        )

    @property
    def display(self) -> np.ndarray:
        """8-bit view scaled by the TRUE bit depth (12-bit -> /4095)."""
        return to_display(self.raw, self.stream.pixel_format, self.stream.significant_bits)

    @property
    def affine(self) -> np.ndarray | None:
        """3x3 homography from the telemetry extras, or None."""
        a = self.extra.get("affine")
        return None if a is None else np.array(a, dtype=np.float64).reshape(3, 3)

    # ---- WS4 4b frame↔voltage binding ------------------------------------
    # Typed accessors over the recorder's `RecordedFrameExtras` schema
    # (app/orchestrator/recorder/metadata.ts — the fixed contract). All
    # optional: frames from older files / free-running capture have no such
    # extras, so every accessor returns None then (backward-compatible).
    # Note the LITERAL dotted JSON keys "volt.unit"/"volt.source" — flat keys,
    # not nested objects — mirrored exactly from the TS schema.

    def _xy(self, key: str) -> XY | None:
        d = self.extra.get(key)
        if not isinstance(d, dict) or "x" not in d or "y" not in d:
            return None
        return XY(float(d["x"]), float(d["y"]))

    @property
    def frame_id(self) -> int | None:
        """Firmware-monotonic FIN capture id (``RecordedFrameExtras.frame_id``)
        bound to the CMD_FRAME that produced this frame, or None if absent."""
        v = self.extra.get("frame_id")
        return None if v is None else int(v)

    @property
    def volt(self) -> XY | None:
        """This stream's mirror voltage ``{x, y}`` — the exposure-AVERAGED value
        when :attr:`volt_source` is ``"fin-averaged"`` (B-12). None if absent."""
        return self._xy("volt")

    @property
    def volt_unit(self) -> str | None:
        """Unit of :attr:`volt` (``"volt"``), or None. Reads the literal
        ``"volt.unit"`` key."""
        return self.extra.get("volt.unit")

    @property
    def volt_source(self) -> str | None:
        """Provenance of :attr:`volt`: ``"fin-averaged"`` (B-12 exposure-average)
        or ``"live-snapshot"``, or None. Reads the literal ``"volt.source"`` key."""
        return self.extra.get("volt.source")

    @property
    def angle(self) -> XY | None:
        """Mirror angle ``{x, y}`` from the telemetry extras, or None."""
        return self._xy("angle")


def _stream_info(channel: Channel) -> StreamInfo:
    meta = channel.metadata
    fmt = meta.get("pixelFormat", "Mono8")
    return StreamInfo(
        name=channel.topic,
        dtype=meta.get("dtype", "U8"),
        shape=tuple(json.loads(meta.get("shape", "[]"))),
        channels=int(meta.get("channels", "1")),
        pixel_format=fmt,
        significant_bits=int(meta.get("significantBits", "0")) or significant_bits(fmt),
    )


class FoveaReader:
    """Reader over one ``.fovea`` file.

    Usage::

        with FoveaReader("dump/recording.fovea") as r:
            r.streams            # {name: StreamInfo}
            r.session            # {"timestamp": ..., "durationSec": ...}
            for frame in r.iter_frames("left-fovea"):
                frame.raw        # ndarray, 12p unpacked
                frame.extra      # telemetry extras (volt/angle/affine)
    """

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._io: IO[bytes] = self.path.open("rb")
        #: True when the indexed path failed (footerless / crash-truncated
        #: file) and frames come from the sequential recovery scan.
        self.truncated = False
        self.streams: dict[str, StreamInfo] = {}
        self.session: dict[str, str] = {}
        self._telemetry: dict[tuple[str, int], dict[str, Any]] = {}
        # Fallback mode only: fully-scanned message list (single pass).
        self._recovered: list[tuple[Channel, Message]] | None = None
        self._open()

    # ---- context management ------------------------------------------------

    def __enter__(self) -> "FoveaReader":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._io.close()

    # ---- opening: indexed first, streaming recovery on failure -------------

    def _open(self) -> None:
        try:
            reader = SeekingReader(self._io)
            summary = reader.get_summary()
            if summary is None or not summary.channels:
                raise McapError("no summary section (footerless file?)")
            self._seeking = reader
            for channel in summary.channels.values():
                if channel.topic != TELEMETRY_TOPIC:
                    self.streams[channel.topic] = _stream_info(channel)
            for metadata in reader.iter_metadata():
                if metadata.name.startswith("fovea:"):
                    self.session.update(metadata.metadata)
        except Exception:  # noqa: BLE001 — footerless/torn files can fail the
            # indexed path with anything from InvalidMagic to a struct.error
            # on a torn record; §2b requires falling back, not failing.
            self.truncated = True
            self._recover()

    def _recover(self) -> None:
        """Sequential scan of a footerless file: keep every complete record
        up to the truncation point, swallow the final partial record."""
        self._io.seek(0)
        reader = NonSeekingReader(self._io)
        self._recovered = []
        # log_time_order=False is load-bearing: the default (True) wraps the
        # scan in sorted(), which consumes the WHOLE stream — the truncation
        # error then fires before a single message is yielded. File order is
        # also what the single-pass telemetry join relies on (docs above).
        iterator = reader.iter_messages(log_time_order=False)
        while True:
            try:
                schema_channel_message = next(iterator)
            except StopIteration:
                break
            except Exception:  # noqa: BLE001 — any parse failure at the
                # truncation boundary (McapError, EOFError, struct.error on a
                # torn length prefix, …) means: stop, keep what we have.
                break
            _schema, channel, message = schema_channel_message
            if channel.topic == TELEMETRY_TOPIC:
                self._note_telemetry(message.data)
            else:
                self.streams.setdefault(channel.topic, _stream_info(channel))
                self._recovered.append((channel, message))
        # parity with the indexed path: yield in log-time order
        self._recovered.sort(key=lambda cm: cm[1].log_time)
        # metadata records live in the data section too — a second tolerant
        # pass picks up fovea:session if it survived (it's written at start).
        self._io.seek(0)
        try:
            for metadata in NonSeekingReader(self._io).iter_metadata():
                if metadata.name.startswith("fovea:"):
                    self.session.update(metadata.metadata)
        except Exception:  # noqa: BLE001 — same tolerance as above
            pass

    # ---- telemetry join -----------------------------------------------------

    @staticmethod
    def _parse_telemetry(
        payload: bytes,
    ) -> tuple[tuple[str, int], dict[str, Any]] | None:
        """Parse one telemetry JSON document into ``((stream, seq), extras)`` —
        or None if it is torn / missing its join key. Shared by the indexed map
        and the streaming join so they can't diverge."""
        try:
            doc = json.loads(payload)
        except json.JSONDecodeError:
            return None
        stream, seq = doc.get("stream"), doc.get("seq")
        if stream is None or seq is None:
            return None
        extras = {k: v for k, v in doc.items() if k not in ("stream", "seq", "t")}
        return (stream, int(seq)), extras

    def _note_telemetry(self, payload: bytes) -> None:
        parsed = self._parse_telemetry(payload)
        if parsed is not None:
            key, extras = parsed
            self._telemetry[key] = extras

    def _load_telemetry(self) -> None:
        if self.truncated or self._telemetry:
            return
        for _schema, _channel, message in self._seeking.iter_messages(
            topics=[TELEMETRY_TOPIC]
        ):
            self._note_telemetry(message.data)

    # ---- frame access --------------------------------------------------------

    def iter_frames(self, stream: str | None = None) -> Iterator[FoveaFrame]:
        """Yield frames (optionally from one stream) in log-time order, each
        joined with its telemetry extras."""
        self._load_telemetry()
        if self._recovered is not None:  # recovery mode: replay the scan
            for channel, message in self._recovered:
                if stream is None or channel.topic == stream:
                    yield self._frame(channel.topic, message)
            return
        topics = None if stream is None else [stream]
        for _schema, channel, message in self._seeking.iter_messages(topics=topics):
            if channel.topic == TELEMETRY_TOPIC:
                continue
            yield self._frame(channel.topic, message)

    def frames(self, stream: str | None = None) -> list[FoveaFrame]:
        return list(self.iter_frames(stream))

    def _stream_source(self) -> IO[bytes]:
        """Fresh binary stream for a forward scan (its own handle, so it never
        disturbs the indexed reader's position). Overridable in tests to
        observe read progress."""
        return self.path.open("rb")

    def iter_frames_streaming(
        self, stream: str | None = None, *, max_pending_telemetry: int = 4096
    ) -> Iterator[FoveaFrame]:
        """Yield frames in FILE order, joining telemetry with BOUNDED state, in
        a single forward pass — no whole-file materialization. Additive to (not
        a replacement for) :meth:`iter_frames`; use this for large recordings
        and streaming/ML pipelines where the log-time sort and full telemetry
        map of ``iter_frames`` would turn the reader into an accidental
        whole-file materializer.

        Differences from ``iter_frames`` (documented tradeoffs, per B-P10):

        - **Order is file order, not log-time order.** The B-5 writer emits a
          frame's telemetry document immediately before the frame on one write
          chain, so a single forward pass sees a frame's extras before the
          frame — no index or second pass needed — but interleaved streams come
          out in write order, not globally sorted by timestamp.
        - **Memory is bounded.** Only telemetry not yet matched to a frame is
          held (normally ~one entry per in-flight stream); orphaned telemetry is
          capped at ``max_pending_telemetry`` (oldest evicted) so a pathological
          file can't grow it without bound.

        Works uniformly on intact AND crash-truncated files: the forward scan
        stops cleanly at the truncation boundary, keeping every complete frame
        before it (same recovery guarantee as the ``truncated`` path, without
        buffering the whole recording first)."""
        pending: dict[tuple[str, int], dict[str, Any]] = {}
        with self._stream_source() as io:
            # log_time_order=False is load-bearing: the default (True) sorts,
            # which drains the whole stream up front (defeating streaming and
            # firing a truncation error before the first yield on torn files).
            iterator = NonSeekingReader(io).iter_messages(log_time_order=False)
            while True:
                try:
                    item = next(iterator)
                except StopIteration:
                    break
                except Exception:  # noqa: BLE001 — stop at the truncation
                    # boundary (McapError/EOFError/struct.error on a torn record)
                    # and keep everything complete before it.
                    break
                _schema, channel, message = item
                if channel.topic == TELEMETRY_TOPIC:
                    parsed = self._parse_telemetry(message.data)
                    if parsed is not None:
                        key, extras = parsed
                        pending[key] = extras
                        if len(pending) > max_pending_telemetry:
                            # Orphaned telemetry (no matching frame written):
                            # evict oldest to stay bounded (dict is insertion-
                            # ordered).
                            pending.pop(next(iter(pending)))
                    continue
                info = self.streams.get(channel.topic)
                if info is None:
                    info = _stream_info(channel)
                    self.streams.setdefault(channel.topic, info)
                if stream is not None and channel.topic != stream:
                    continue
                extras = pending.pop((channel.topic, message.sequence), {})
                yield FoveaFrame(
                    stream=info,
                    seq=message.sequence,
                    log_time=message.log_time,
                    data=message.data,
                    extra=extras,
                )

    def _frame(self, topic: str, message: Message) -> FoveaFrame:
        info = self.streams[topic]
        return FoveaFrame(
            stream=info,
            seq=message.sequence,
            log_time=message.log_time,
            data=message.data,
            extra=self._telemetry.get((topic, message.sequence), {}),
        )
