# ------------------------------------------------------
# Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
import argparse, sys, json, time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

try:
    import numpy as np
except ImportError:
    print("NumPy is required but not installed.")
    sys.exit(1)

try:
    import cv2
except ImportError:
    print("OpenCV is required but not installed.")
    sys.exit(1)

# Must match Dtype from lib/util/dtype.ts
type Dtype = Literal["U8", "I8", "U16", "I16", "U32", "I32", "F32", "F64", "U64", "I64"]

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

# Must match PixelFormat from core/Aravis
type PixelFormat = Literal[
    "Mono8",
    "RGB8",
    "BGR8",
    "RGBA8",
    "BGRA8",
    "BayerGR8",
    "BayerRG8",
    "BayerGB8",
    "BayerBG8",
    "Mono16",
    "BayerGR16",
    "BayerRG16",
    "BayerGB16",
    "BayerBG16",
]

BAYER_CODE: dict[str, int] = {
    "BayerGR8": cv2.COLOR_BayerGR2BGR,
    "BayerRG8": cv2.COLOR_BayerRG2BGR,
    "BayerGB8": cv2.COLOR_BayerGB2BGR,
    "BayerBG8": cv2.COLOR_BayerBG2BGR,
    "BayerGR16": cv2.COLOR_BayerGR2BGR,
    "BayerRG16": cv2.COLOR_BayerRG2BGR,
    "BayerGB16": cv2.COLOR_BayerGB2BGR,
    "BayerBG16": cv2.COLOR_BayerBG2BGR,
}


@dataclass
class Frame:
    """Corresponds to FrameMeta in stream.ts"""

    stream: "Stream"
    offset: int  # o: byte offset in .stream file
    size: int  # n: length in bytes
    shape: list[int]  # s: shape of the frame data
    dtype: Dtype  # d: dtype
    timestamp: float  # t: timestamp in seconds
    format: PixelFormat  # f: pixel format
    extra: dict = field(default_factory=dict)  # x: extra metadata

    @property
    def raw(self) -> np.ndarray:
        """Read raw frame data from the blob file."""
        self.stream.blob.seek(self.offset)
        buffer = self.stream.blob.read(self.size)
        if len(buffer) != self.size:
            raise ValueError(
                f"Expected {self.size} bytes at offset {self.offset}, got {len(buffer)}"
            )
        return np.frombuffer(buffer, dtype=NUMPY_DTYPE[self.dtype]).reshape(self.shape)

    @property
    def affine(self) -> np.ndarray | None:
        """Return 3x3 affine/homography matrix from extra metadata, or None."""
        a = self.extra.get("affine")
        if a is None:
            return None
        return np.array(a, dtype=np.float64)

    @property
    def image(self) -> np.ndarray:
        """Read and demosaic/convert frame for display."""
        raw = self.raw
        fmt = self.format
        if fmt in BAYER_CODE:
            img = cv2.cvtColor(raw, BAYER_CODE[fmt])
        elif fmt in ("RGB8",):
            img = cv2.cvtColor(raw, cv2.COLOR_RGB2BGR)
        elif fmt in ("RGBA8",):
            img = cv2.cvtColor(raw, cv2.COLOR_RGBA2BGR)
        else:
            # Mono8, Mono16, BGR8, BGRA8 — display directly
            img = raw
        H = self.affine
        if H is not None:
            h, w = img.shape[:2]
            img = cv2.warpPerspective(img, H, (w, h))
        return img


def parse_meta_line(line: str) -> dict:
    """Parse a FrameMeta JSON line (short keys) into Frame kwargs."""
    m = json.loads(line)
    return dict(
        offset=m["o"],
        size=m["n"],
        shape=m["s"],
        dtype=m["d"],
        timestamp=m["t"],
        format=m["f"],
        extra=m.get("x", {}),
    )


class Stream(list[Frame]):
    def __init__(self, path: str):
        super().__init__()
        # Strip known suffixes to get the base path
        p = path
        for suffix in (".meta", ".stream"):
            if p.endswith(suffix):
                p = p[: -len(suffix)]
        self.name = Path(p).name
        # Open binary blob
        stream_path = Path(p + ".stream")
        if not stream_path.exists():
            raise FileNotFoundError(f"Stream file not found: {stream_path}")
        self.blob = stream_path.open("rb")
        # Parse meta sidecar
        meta_path = Path(p + ".meta")
        if not meta_path.exists():
            raise FileNotFoundError(f"Meta file not found: {meta_path}")
        with open(meta_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    kw = parse_meta_line(line)
                except (json.JSONDecodeError, KeyError) as e:
                    print(f"Warning: skipping invalid meta line: {e}")
                    continue
                self.append(Frame(stream=self, **kw))

    def close(self):
        self.blob.close()


def play(streams: list[Stream], speed: float = 1.0):
    streams = [s for s in streams if len(s) > 0]
    if not streams:
        print("No frames to play.")
        return

    for stream in streams:
        cv2.namedWindow(stream.name, cv2.WINDOW_NORMAL)

    KEY_SPACE = ord(" ")
    KEY_BACKSPACE = 8
    KEY_Q = ord("q")
    KEY_ESC = 27

    def restart():
        nonlocal cursors, clock, paused
        cursors = [0] * len(streams)
        clock = time.monotonic()
        paused = False

    t0 = min(s[0].timestamp for s in streams)
    cursors = [0] * len(streams)
    clock = time.monotonic()
    paused = False
    pause_at = 0.0

    while True:
        if paused:
            t = t0 + pause_at * speed
        else:
            t = t0 + (time.monotonic() - clock) * speed

        done = True
        for i, s in enumerate(streams):
            while cursors[i] + 1 < len(s) and s[cursors[i] + 1].timestamp <= t:
                cursors[i] += 1
            if cursors[i] < len(s) and s[cursors[i]].timestamp <= t:
                cv2.imshow(s.name, s[cursors[i]].image)
            if cursors[i] < len(s) - 1:
                done = False

        key = cv2.waitKey(1 if not (paused or done) else 0) & 0xFF
        if key in (KEY_Q, KEY_ESC):
            break
        if key == KEY_BACKSPACE:
            restart()
            continue
        if key == KEY_SPACE:
            if done:
                restart()
                continue
            paused = not paused
            if paused:
                pause_at = time.monotonic() - clock
            else:
                clock = time.monotonic() - pause_at
            continue

    cv2.destroyAllWindows()
    for s in streams:
        s.close()


def getAllStreams():
    dir = Path(__file__).parent
    ret = dict[str, Stream]()
    for meta_path in dir.glob("*.meta"):
        stream_path = meta_path.with_suffix(".stream")
        if stream_path.exists():
            ret[meta_path.stem] = Stream(str(meta_path))
    return ret


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Play FoveaCam recording streams.")
    parser.add_argument(
        "streams",
        nargs="*",
        type=Stream,
        help="Stream files (.stream or .meta) to play.",
    )
    parser.add_argument(
        "-s",
        "--speed",
        type=float,
        default=1.0,
        help="Playback speed multiplier (default: 1.0).",
    )
    args = parser.parse_args()
    streams: list[Stream] = args.streams
    speed = args.speed
    if len(streams) == 0:
        streams = list(getAllStreams().values())
    play(streams, speed=speed)
