# GENERATED from docs/schema/pixel-formats.ts by
# docs/schema/generate-pixel-formats.ts — DO NOT EDIT BY HAND.
# Edit the source table and rerun the generator, then commit both.
"""Mirror of docs/schema/pixel-formats.ts — the sensor pixel-format registry.

The single source is the TS table; this checked-in mirror lets pyfovea consume
the same format facts without importing app code (same pattern as schema.py).
"""

from __future__ import annotations

from typing import NamedTuple, Optional


class PixelFormatSpec(NamedTuple):
    name: str
    aravis: str
    cv: str
    dtype: str
    channels: int
    significant_bits: int
    is_packed: bool
    bayer: Optional[str]


PIXEL_FORMATS: tuple[PixelFormatSpec, ...] = (
    PixelFormatSpec(name="Mono8", aravis="ARV_PIXEL_FORMAT_MONO_8", cv="U8C1", dtype="U8", channels=1, significant_bits=8, is_packed=False, bayer=None),
    PixelFormatSpec(name="Mono16", aravis="ARV_PIXEL_FORMAT_MONO_16", cv="U16C1", dtype="U16", channels=1, significant_bits=16, is_packed=False, bayer=None),
    PixelFormatSpec(name="RGB8", aravis="ARV_PIXEL_FORMAT_RGB_8_PACKED", cv="U8C3", dtype="U8", channels=3, significant_bits=8, is_packed=False, bayer=None),
    PixelFormatSpec(name="BGR8", aravis="ARV_PIXEL_FORMAT_BGR_8_PACKED", cv="U8C3", dtype="U8", channels=3, significant_bits=8, is_packed=False, bayer=None),
    PixelFormatSpec(name="RGBA8", aravis="ARV_PIXEL_FORMAT_RGBA_8_PACKED", cv="U8C4", dtype="U8", channels=4, significant_bits=8, is_packed=False, bayer=None),
    PixelFormatSpec(name="BGRA8", aravis="ARV_PIXEL_FORMAT_BGRA_8_PACKED", cv="U8C4", dtype="U8", channels=4, significant_bits=8, is_packed=False, bayer=None),
    PixelFormatSpec(name="BayerGR8", aravis="ARV_PIXEL_FORMAT_BAYER_GR_8", cv="U8C1", dtype="U8", channels=1, significant_bits=8, is_packed=False, bayer="BayerGR"),
    PixelFormatSpec(name="BayerRG8", aravis="ARV_PIXEL_FORMAT_BAYER_RG_8", cv="U8C1", dtype="U8", channels=1, significant_bits=8, is_packed=False, bayer="BayerRG"),
    PixelFormatSpec(name="BayerGB8", aravis="ARV_PIXEL_FORMAT_BAYER_GB_8", cv="U8C1", dtype="U8", channels=1, significant_bits=8, is_packed=False, bayer="BayerGB"),
    PixelFormatSpec(name="BayerBG8", aravis="ARV_PIXEL_FORMAT_BAYER_BG_8", cv="U8C1", dtype="U8", channels=1, significant_bits=8, is_packed=False, bayer="BayerBG"),
    PixelFormatSpec(name="BayerGR16", aravis="ARV_PIXEL_FORMAT_BAYER_GR_16", cv="U16C1", dtype="U16", channels=1, significant_bits=16, is_packed=False, bayer="BayerGR"),
    PixelFormatSpec(name="BayerRG16", aravis="ARV_PIXEL_FORMAT_BAYER_RG_16", cv="U16C1", dtype="U16", channels=1, significant_bits=16, is_packed=False, bayer="BayerRG"),
    PixelFormatSpec(name="BayerGB16", aravis="ARV_PIXEL_FORMAT_BAYER_GB_16", cv="U16C1", dtype="U16", channels=1, significant_bits=16, is_packed=False, bayer="BayerGB"),
    PixelFormatSpec(name="BayerBG16", aravis="ARV_PIXEL_FORMAT_BAYER_BG_16", cv="U16C1", dtype="U16", channels=1, significant_bits=16, is_packed=False, bayer="BayerBG"),
    PixelFormatSpec(name="Mono12p", aravis="ARV_PIXEL_FORMAT_MONO_12P", cv="U16C1", dtype="U16", channels=1, significant_bits=12, is_packed=True, bayer=None),
    PixelFormatSpec(name="BayerGR12p", aravis="ARV_PIXEL_FORMAT_BAYER_GR_12P", cv="U16C1", dtype="U16", channels=1, significant_bits=12, is_packed=True, bayer="BayerGR"),
    PixelFormatSpec(name="BayerRG12p", aravis="ARV_PIXEL_FORMAT_BAYER_RG_12P", cv="U16C1", dtype="U16", channels=1, significant_bits=12, is_packed=True, bayer="BayerRG"),
    PixelFormatSpec(name="BayerGB12p", aravis="ARV_PIXEL_FORMAT_BAYER_GB_12P", cv="U16C1", dtype="U16", channels=1, significant_bits=12, is_packed=True, bayer="BayerGB"),
    PixelFormatSpec(name="BayerBG12p", aravis="ARV_PIXEL_FORMAT_BAYER_BG_12P", cv="U16C1", dtype="U16", channels=1, significant_bits=12, is_packed=True, bayer="BayerBG"),
)

#: All canonical format names, in registry order.
PIXEL_FORMAT_NAMES: tuple[str, ...] = tuple(f.name for f in PIXEL_FORMATS)

#: Distinct Bayer mosaic prefixes, in first-seen order.
BAYER_PATTERNS: tuple[str, ...] = ("BayerGR", "BayerRG", "BayerGB", "BayerBG",)

_BY_NAME = {f.name: f for f in PIXEL_FORMATS}


def pixel_format_spec(name: str) -> Optional[PixelFormatSpec]:
    """Look up a format spec by name (None if unknown)."""
    return _BY_NAME.get(name)
