# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""``fcap`` CLI — inspect / export / convert.

- ``fcap inspect <file.fcap | legacy-dir>`` — streams, counts, timing,
  session metadata (works on crash-truncated files via the recovery path).
  Reads ``.fcap`` and legacy ``.fovea`` containers alike (extension-agnostic).
- ``fcap export <file.fcap> [-s stream] [-o dir] [-f npy|pgm]`` — dump
  frames as ``.npy`` (raw, exact) or ``.pgm`` (8-bit display-scaled,
  mono-only; pure stdlib — no OpenCV requirement).
- ``fcap convert <legacy-dir> [-o out.fcap]`` — re-encode a legacy
  ``.stream``/``.meta`` dump as a single ``.fcap`` container (§2b schema).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np


def _open_any(path: Path):
    """Return ("fovea", FoveaReader) or ("legacy", LegacyRecording)."""
    from .fovea import FoveaReader
    from .legacy import LegacyRecording

    if path.is_dir():
        return "legacy", LegacyRecording(path)
    return "fovea", FoveaReader(path)


def cmd_inspect(args: argparse.Namespace) -> int:
    kind, reader = _open_any(Path(args.path))
    with reader:
        if kind == "legacy":
            print(f"{args.path}: legacy .stream/.meta dump")
            manifest = reader.manifest
            if manifest:
                print(f"  format={manifest.get('format')} timestamp={manifest.get('timestamp')}"
                      f" duration={manifest.get('duration')}s")
            for name, stream in reader.streams.items():
                if len(stream) == 0:
                    print(f"  {name}: 0 frames")
                    continue
                first, last = stream[0], stream[-1]
                span = last.timestamp - first.timestamp
                fps = (len(stream) - 1) / span if span > 0 else 0.0
                print(
                    f"  {name}: {len(stream)} frames, {first.format} {list(first.shape)}"
                    f" {first.dtype} ({first.significant_bits} bits),"
                    f" t=[{first.timestamp:.3f}, {last.timestamp:.3f}]s (~{fps:.1f} fps)"
                )
            return 0

        flag = " [TRUNCATED — recovered via streaming scan]" if reader.truncated else ""
        print(f"{args.path}: MCAP container{flag}")
        if reader.session:
            print("  session: " + ", ".join(f"{k}={v}" for k, v in sorted(reader.session.items())))
        for name, info in reader.streams.items():
            frames = reader.frames(name)
            if not frames:
                print(f"  {name}: 0 frames")
                continue
            span = frames[-1].t - frames[0].t
            fps = (len(frames) - 1) / span if span > 0 else 0.0
            with_extra = sum(1 for f in frames if f.extra)
            print(
                f"  {name}: {len(frames)} frames, {info.pixel_format} {list(info.shape)}"
                f" {info.dtype} ({info.significant_bits} bits),"
                f" t=[{frames[0].t:.3f}, {frames[-1].t:.3f}]s (~{fps:.1f} fps),"
                f" {with_extra} with telemetry"
            )
        return 0


def _write_pgm(path: Path, img: np.ndarray) -> None:
    if img.ndim != 2:
        raise ValueError("pgm export supports mono frames only — use -f npy")
    with path.open("wb") as f:
        f.write(f"P5\n{img.shape[1]} {img.shape[0]}\n255\n".encode())
        f.write(np.ascontiguousarray(img, dtype=np.uint8).tobytes())


def cmd_export(args: argparse.Namespace) -> int:
    from .fovea import FoveaReader

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    written = 0
    with FoveaReader(args.path) as reader:
        for frame in reader.iter_frames(args.stream):
            base = out / f"{frame.stream.name}-{frame.seq:06d}"
            if args.format == "npy":
                np.save(base.with_suffix(".npy"), frame.raw)
                if frame.extra:
                    base.with_suffix(".json").write_text(json.dumps(frame.extra))
            else:
                _write_pgm(base.with_suffix(".pgm"), frame.display)
            written += 1
    print(f"exported {written} frames to {out}")
    return 0 if written else 1


def cmd_convert(args: argparse.Namespace) -> int:
    from .convert import convert_legacy

    src = Path(args.path)
    dst = Path(args.output) if args.output else src / f"{src.resolve().name}.fcap"
    counts = convert_legacy(src, dst)
    total = sum(counts.values())
    per = ", ".join(f"{k}={v}" for k, v in counts.items())
    print(f"converted {total} frames ({per}) -> {dst}")
    return 0 if total else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="fcap",
        description="Read, export and convert FoveaCam recordings "
        "(.fcap MCAP containers, legacy .fovea, and legacy .stream/.meta dumps).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("inspect", help="summarize a .fcap/.fovea file or legacy dump directory")
    p.add_argument("path")
    p.set_defaults(fn=cmd_inspect)

    p = sub.add_parser("export", help="dump frames from a .fcap/.fovea file")
    p.add_argument("path")
    p.add_argument("-s", "--stream", default=None, help="only this stream (default: all)")
    p.add_argument("-o", "--output", default="./export", help="output directory")
    p.add_argument("-f", "--format", choices=("npy", "pgm"), default="npy")
    p.set_defaults(fn=cmd_export)

    p = sub.add_parser("convert", help="legacy dump directory -> single .fcap container")
    p.add_argument("path")
    p.add_argument("-o", "--output", default=None, help="output .fcap path")
    p.set_defaults(fn=cmd_convert)

    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
