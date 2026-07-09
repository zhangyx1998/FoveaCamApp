# ------------------------------------------------------
# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
# This source code is licensed under the MIT license.
# You may find the full license in project root directory.
# -------------------------------------------------------
"""Coverage for the generated pixel-format registry mirror (B-P1/B-11):
``pyfcap/src/fcap/pixel_formats.py`` is generated from
``docs/schema/pixel-formats.ts`` and is the single source `dtypes.py` reads.
These tests lock its internal consistency (so generator drift or a hand-edit is
caught) and its agreement with `significant_bits`/`BAYER_PATTERNS`. Purely
schema-as-code — no runtime behavior."""

import pytest

from fcap.dtypes import significant_bits
from fcap.pixel_formats import (
    BAYER_PATTERNS,
    PIXEL_FORMAT_NAMES,
    PIXEL_FORMATS,
    PixelFormatSpec,
    pixel_format_spec,
)

_KNOWN_BAYER = ("BayerGR", "BayerRG", "BayerGB", "BayerBG")


def test_registry_shape():
    # 19 formats today (4 mono/16 + 6 color + 4 bayer8 + 4 bayer16 + 5 12p — see
    # the source table); all names unique; PIXEL_FORMAT_NAMES tracks the table.
    assert len(PIXEL_FORMATS) == 19
    names = [f.name for f in PIXEL_FORMATS]
    assert len(set(names)) == len(names)
    assert PIXEL_FORMAT_NAMES == tuple(names)
    assert all(isinstance(f, PixelFormatSpec) for f in PIXEL_FORMATS)


def test_fields_cohere_with_naming_convention():
    # Every generated row must agree with the format-name convention — this is
    # what the suffix-fallback in significant_bits() assumes, so a drift here
    # would silently desync the registry from the fallback.
    for f in PIXEL_FORMATS:
        assert f.is_packed == f.name.endswith("12p"), f.name
        if f.name.endswith("12p"):
            assert f.significant_bits == 12, f.name
        elif f.name.endswith("16"):
            assert f.significant_bits == 16, f.name
        else:
            assert f.significant_bits == 8, f.name
        expected_bayer = next((p for p in _KNOWN_BAYER if f.name.startswith(p)), None)
        assert f.bayer == expected_bayer, f.name
        # packed 12p unpacks to a 16-bit container; dtype/cv reflect that
        if f.is_packed:
            assert f.dtype == "U16" and f.cv == "U16C1", f.name


def test_bayer_patterns_are_the_distinct_prefixes_first_seen():
    assert BAYER_PATTERNS == _KNOWN_BAYER
    # exactly the set the rows carry (order = first appearance)
    seen: list[str] = []
    for f in PIXEL_FORMATS:
        if f.bayer and f.bayer not in seen:
            seen.append(f.bayer)
    assert tuple(seen) == BAYER_PATTERNS


def test_pixel_format_spec_lookup():
    for f in PIXEL_FORMATS:
        assert pixel_format_spec(f.name) is f
    assert pixel_format_spec("NotAFormat") is None


def test_significant_bits_matches_registry_for_every_known_format():
    for f in PIXEL_FORMATS:
        assert significant_bits(f.name) == f.significant_bits, f.name


def test_significant_bits_declared_override_and_legacy_fallback():
    # declared value wins even against a known format
    assert significant_bits("Mono8", declared=10) == 10
    # unknown/legacy names fall back to the suffix heuristic (registry miss)
    assert significant_bits("SomethingWeird12p") == 12
    assert significant_bits("LegacyMono16") == 16
    assert significant_bits("whatever") == 8
