# Calibration record format (store schema v1)

The on-disk contract for calibration records and their export files. Design
rationale is in
[`docs/proposals/calibration-records-v2.md`](../proposals/calibration-records-v2.md);
this doc is the format spec — enough to hand-craft a valid JSON. The canonical
types live in [`app/lib/calibration-records.ts`](../../app/lib/calibration-records.ts).

## Store layout (schema v1)

```
store/
  schema.json                     # { "version": 1 }
  calibration-records/<id>.json   # one CalibrationRecord per file, <id> == its hash
  triples/<hash>.json             # per-triple config (nickname + overrides)
  calibrate-intrinsic/<cameraKey>.json
  ui/cal-overlay.json             # live overlay toggle state
```

Before v1 (schema v0) extrinsic data was a flat array at
`calibrate-extrinsic/<cameraKey>.json`. The `0 → 1` migration wraps each such
array as a record, computes its hash id, writes
`calibration-records/<id>.json`, and removes the legacy file. `.raw`-suffixed
legacy extrinsic files are left verbatim.

## `CalibrationRecord`

```jsonc
{
  "id": "<sha256-hex>",            // == SHA-256(canonicalize(inner)); also the filename
  "inner": {                       // IMMUTABLE — the hash pre-image
    "kind": "extrinsic",
    "dataset": [ /* ExtrinsicData[] — see below */ ]
  },
  "outer": {                       // MUTABLE — edit freely, id never changes
    "created": "2026-07-10T12:00:00.000Z",   // ISO-8601, latest-first ordering key
    "label": "optional human label",
    "associations": [
      { "cameraKey": "FLIR_Blackfly-S-BFS-U3-16S2C_24044020",
        "tripleHash": "<sha256-hex, optional>",
        "role": "L" }              // "L" | "R", advisory
    ],
    "sources": ["<id>", "<id>"]    // present only on AGGREGATED records
  }
}
```

- **`id` derivation** — `canonicalize` = JSON with object keys sorted
  recursively (array order preserved), `undefined`/absent fields omitted; then
  SHA-256 of that string, hex. The `id` field is advisory on import: the reader
  recomputes it from `inner` and warns on a mismatch.
- **`associations`** is the refcount: an empty list means the record is orphaned
  and its file is trashed. A record belongs to triple `T` when a binding has
  `tripleHash === T`, or (legacy) no `tripleHash` and `cameraKey` is one of `T`'s
  live L/R cameras.

### `ExtrinsicData` (one datapoint)

```jsonc
{
  "img_points":  [ { "x": 476.58, "y": 295.87 }, ... ],  // fovea corners (first 4 = outer quad)
  "obj_points":  [ { "x": -0.5, "y": -0.5, "z": 0 }, ... ], // object-space corners
  "voltage":     { "x": 1.2, "y": -0.3 },                 // MEMS voltage (V)
  "angle":       { "x": 0.01, "y": 0.02 },                // wide-camera angle (rad)
  // optional measured-magnification inputs (absent on legacy datasets):
  "wide_img_points":    [ /* 4 pts */ ],
  "wide_center_points": [ /* 4 pts */ ],
  "marker": { "side_mm": 60, "center_mm": 60 }
}
```

## Export files

### Single record — `fovea-calibration-record@1`

```jsonc
{
  "schema": "fovea-calibration-record@1",
  "exported": "2026-07-10T12:00:00.000Z",
  "record": {                      // associations STRIPPED
    "id": "<sha256-hex>",
    "inner": { "kind": "extrinsic", "dataset": [ ... ] },
    "created": "2026-07-01T00:00:00.000Z",
    "label": "optional",
    "sources": ["<id>"],           // if aggregated
    "role": "L"                    // advisory — for re-binding on import
  }
}
```

Importing into a triple: recompute the id from `inner`; if a record with that id
exists, **add an association** to the importing triple (warn if the existing
`inner` differs); otherwise **create** the record bound to the importing triple.

### Device config bundle — `fovea-device-config@1`

```jsonc
{
  "schema": "fovea-device-config@1",
  "exported": "2026-07-10T12:00:00.000Z",
  "sourceTripleHash": "<sha256-hex>",   // provenance; a re-import onto the SAME rig skips the nickname prompt
  "config": {                            // the per-triple doc verbatim
    "nickname": "Lab Rig",
    "baseline_mm": 180,
    "zoom_override": 9,
    "settle_time_us": 2000,
    "delay_compensation_ms": -5,
    "drift_l": { "x": 0, "y": 0 },
    "drift_r": { "x": 0, "y": 0 }
  },
  "records": [ /* RecordExport[] — same shape as the single-record `record`, associations stripped */ ]
}
```

Importing a device bundle: merge `config` onto the selected triple's doc (a
**cross-triple** import — `sourceTripleHash` ≠ the target — prompts for a new
nickname, which overrides `config.nickname`), then import each record as above.

## Overlay state — `ui/cal-overlay.json`

```jsonc
{ "recordId": "<id> | null", "cameraKey": "<cameraKey> | null", "role": "L | R | null" }
```

Live cross-window toggle for the extrinsic visualizer overlay. `null` = off.
