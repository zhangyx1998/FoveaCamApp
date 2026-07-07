# ------------------------------------------------------
# Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
import argparse, sys, json, time, subprocess
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
    "Mono12p",
    "BayerGR12p",
    "BayerRG12p",
    "BayerGB12p",
    "BayerBG12p",
]

BAYER_CODE: dict[str, int] = {
    "BayerGR8": cv2.COLOR_BayerGR2RGB,
    "BayerRG8": cv2.COLOR_BayerRG2RGB,
    "BayerGB8": cv2.COLOR_BayerGB2RGB,
    "BayerBG8": cv2.COLOR_BayerBG2RGB,
    "BayerGR16": cv2.COLOR_BayerGR2RGB,
    "BayerRG16": cv2.COLOR_BayerRG2RGB,
    "BayerGB16": cv2.COLOR_BayerGB2RGB,
    "BayerBG16": cv2.COLOR_BayerBG2RGB,
    # 12-bit packed are unpacked to 16-bit before demosaic; same Bayer codes.
    "BayerGR12p": cv2.COLOR_BayerGR2RGB,
    "BayerRG12p": cv2.COLOR_BayerRG2RGB,
    "BayerGB12p": cv2.COLOR_BayerGB2RGB,
    "BayerBG12p": cv2.COLOR_BayerBG2RGB,
}


def significant_bits(fmt: str, declared: int = 0) -> int:
    """Effective bit depth of pixel data. Prefer the value carried in the meta
    sidecar; otherwise derive from the format name (12p data lives 0..4095 in a
    16-bit container, so it must be scaled by 4095, not 65535)."""
    if declared:
        return declared
    if fmt.endswith("12p"):
        return 12
    if fmt.endswith("16"):
        return 16
    return 8


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
    bits: int = 0  # b: significant bit depth (0 = derive from format)
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
            # Mono8, Mono16, Mono12p, BGR8, BGRA8 — display directly
            img = raw
        # Normalize >8-bit data to 8-bit using its true bit depth, so 12-bit
        # data (0..4095 in a 16-bit container) is not rendered ~16x too dark.
        if img.dtype != np.uint8:
            max_val = (1 << significant_bits(fmt, self.bits)) - 1
            img = (
                (img.astype(np.uint32) * 255 // max_val).clip(0, 255).astype(np.uint8)
            )
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
        bits=m.get("b", 0),
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


def to_bgr(img: np.ndarray) -> np.ndarray:
    """Normalize image to 3-channel 8-bit BGR for display/concatenation."""
    if img.dtype != np.uint8:
        # Scale 16-bit (or other) down to 8-bit for display
        info = np.iinfo(img.dtype) if np.issubdtype(img.dtype, np.integer) else None
        if info is not None and info.max > 255:
            img = (img.astype(np.uint32) * 255 // info.max).astype(np.uint8)
        else:
            img = img.astype(np.uint8)
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    return img


def play(streams: list[Stream], speed: float = 1.0, cat: bool = False):
    streams = [s for s in streams if len(s) > 0]
    if not streams:
        print("No frames to play.")
        return

    CAT_WINDOW = "streams"
    if cat:
        cv2.namedWindow(CAT_WINDOW, cv2.WINDOW_NORMAL)
    else:
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
    last_shown = [-1] * len(streams)
    latest_images: list[np.ndarray | None] = [None] * len(streams)
    clock = time.monotonic()
    paused = False
    pause_at = 0.0

    while True:
        if paused:
            t = t0 + pause_at * speed
        else:
            t = t0 + (time.monotonic() - clock) * speed

        done = True
        updated = False
        for i, s in enumerate(streams):
            while cursors[i] + 1 < len(s) and s[cursors[i] + 1].timestamp <= t:
                cursors[i] += 1
            if cursors[i] < len(s) and s[cursors[i]].timestamp <= t:
                if last_shown[i] != cursors[i]:
                    img = s[cursors[i]].image
                    latest_images[i] = img
                    last_shown[i] = cursors[i]
                    updated = True
                    if not cat:
                        cv2.imshow(s.name, img)
            if cursors[i] < len(s) - 1:
                done = False

        if cat and updated:
            imgs: list[np.ndarray] = [im for im in latest_images if im is not None]
            if len(imgs) == len(streams):
                bgr = [to_bgr(im) for im in imgs]
                h_max = max(im.shape[0] for im in bgr)
                resized: list[np.ndarray] = []
                for im in bgr:
                    h, w = im.shape[:2]
                    if h != h_max:
                        new_w = max(1, int(round(w * h_max / h)))
                        im = cv2.resize(
                            im, (new_w, h_max), interpolation=cv2.INTER_AREA
                        )
                    resized.append(im)
                cv2.imshow(CAT_WINDOW, cv2.hconcat(resized))

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


def export(streams: list[Stream], suffix: str = ".mov"):
    try:
        from tqdm import tqdm
    except ImportError:
        print("tqdm is required for export but not installed.")
        sys.exit(1)

    streams = [s for s in streams if len(s) > 0]
    if not streams:
        print("No frames to export.")
        return

    for stream in streams:
        if len(stream) >= 2:
            duration = stream[-1].timestamp - stream[0].timestamp
            fps = (len(stream) - 1) / duration if duration > 0 else 30.0
        else:
            fps = 30.0

        first = to_bgr(stream[0].image)
        h, w = first.shape[:2]

        out_path = Path(stream.blob.name).with_suffix(suffix)
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "rawvideo",
            "-pix_fmt", "bgr24",
            "-s", f"{w}x{h}",
            "-r", f"{fps:.6f}",
            "-i", "-",
            "-c:v", "prores_ks",
            "-profile:v", "3",
            "-pix_fmt", "yuv422p10le",
            str(out_path),
        ]

        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        assert proc.stdin is not None
        try:
            bar = tqdm(stream, desc=f"{stream.name} @ {fps:.2f}fps", unit="f")
            for frame in bar:
                img = to_bgr(frame.image)
                if img.shape[:2] != (h, w):
                    img = cv2.resize(img, (w, h))
                proc.stdin.write(img.tobytes())
        finally:
            proc.stdin.close()
            rc = proc.wait()
            stream.close()
            if rc != 0:
                print(f"ffmpeg exited with code {rc} for {stream.name}")


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
    parser.add_argument(
        "-c",
        "--cat",
        action="store_true",
        help="Render all streams in one window, resized to the largest height and concatenated horizontally.",
    )
    parser.add_argument(
        "-e",
        "--export",
        nargs="?",
        const=".mov",
        default=None,
        metavar="SUFFIX",
        help="Export each stream to a ProRes video file (default suffix: .mov) via ffmpeg, no GUI.",
    )
    args = parser.parse_args()
    streams: list[Stream] = args.streams
    speed = args.speed
    if len(streams) == 0:
        streams = list(getAllStreams().values())
    if args.export is not None:
        export(streams, suffix=args.export)
    else:
        play(streams, speed=speed, cat=args.cat)
