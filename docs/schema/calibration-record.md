# Calibration record format (store schema v2)

The on-disk contract for calibration records and their export files. This is the
format spec — enough to hand-craft a valid EXTRINSIC JSON (plain point arrays).
Intrinsic ids are
tool-computed only: their inner data folds Float64 Mats into the codec's
`{type, buffer: base64, props}` canonical form before hashing, which is not
practical by hand — use `recordId()` from the lib. The canonical types live in
[`app/lib/calibration-records.ts`](../../app/lib/calibration-records.ts).

## Store layout (schema v2)

```
store/
  schema.json                     # { "version": 2 }
  calibrate-extrinsic/<id>.json   # one EXTRINSIC CalibrationRecord, <id> == its hash
  calibrate-intrinsic/<id>.json   # one INTRINSIC CalibrationRecord, <id> == its hash
  triples/<hash>.json             # per-triple config (nickname + overrides)
  ui/cal-overlay.json             # live overlay toggle state
```

Both kinds of record live in a PER-KIND directory keyed by their content-hash
`<id>` (see below). The `calibrate-*` directories may ALSO hold `.raw`-suffixed
analysis artifacts (hand-produced, not schema docs) — readers skip any name that
is not a 32-hex id. There is no longer a flat `calibration-records/` directory
(schema v1 had one; v2 removed it).

### Ids: 32-hex truncated SHA-256

Every record `<id>` AND every triple `<hash>` is the **first 32 hex digits**
(128 bits) of a SHA-256 — the full 64-hex digest truncated. Camera keys
(`vendor_model_serial`) carry non-hex vendor/model prefixes, so a `<cameraKey>`
name is always distinguishable from a 32-hex id.

### Migrations

- **v0 → v1** wrapped each flat `calibrate-extrinsic/<cameraKey>.json` array as a
  record (then in `calibration-records/`).
- **v1 → v2** moved every record into its per-kind directory (truncating the id
  to 32 hex and re-keying any 64-hex `tripleHash`), **wrapped** each legacy
  `calibrate-intrinsic/<cameraKey>.json` `CameraCalibration` doc as an intrinsic
  record, **re-keyed** `triples/<hash64>` → `triples/<hash32>`, and removed the
  flat `calibration-records/` directory. `.raw` artifacts are left verbatim.

## `CalibrationRecord`

```jsonc
{
  "id": "<id>",                    // == recordId(inner) = 32-hex SHA-256(canonicalize(inner)); also the filename
  "inner": { /* IMMUTABLE hash pre-image — one of the two shapes below */ },
  "outer": {                       // MUTABLE — edit freely, id never changes
    "created": "2025-01-15T12:00:00.000Z",   // ISO-8601, latest-first ordering key
    "label": "optional human label",
    "associations": [
      { "cameraKey": "FLIR_Blackfly-S-BFS-U3-16S2C_24044020",
        "tripleHash": "<id, optional>",
        "role": "L" }              // "L" | "C" | "R", advisory
    ],
    "sources": ["<id>", "<id>"]    // present only on AGGREGATED records (extrinsic)
  }
}
```

### `inner` — extrinsic

```jsonc
{ "kind": "extrinsic", "dataset": [ /* ExtrinsicData[] — see below */ ] }
```

### `inner` — intrinsic

```jsonc
{
  "kind": "intrinsic",
  "calibration": {                 // the CameraCalibration SOLVE PAYLOAD, MINUS `date`
    "sensor_size":  { "width": 1280, "height": 960 },
    "camera_matrix": { "type": "Float64Array", "buffer": "<base64>", "props": { "shape": [3,3], "channels": 1 } },
    "dist_coeffs":   { "type": "Float64Array", "buffer": "<base64>", "props": { "shape": [1,5], "channels": 1 } },
    "rvecs": [ /* per-view Mats */ ],
    "tvecs": [ /* per-view Mats */ ],
    "rms": 0.31                    // optional (solve re-projection error)
  }
}
```

The intrinsic solve's volatile `date` is NOT in `inner` — it becomes
`outer.created` (the ordering key). The Mats are stored in the config store's
codec form (`{ type, buffer: base64, props }`); the app revives them to
`Float64Array`s carrying `shape`/`channels` when it reads the record.

- **`id` derivation** — `canonicalize` = JSON with object keys sorted
  recursively (array order preserved), `undefined`/absent fields omitted, and
  **TypedArrays/ArrayBuffers folded into `{ type, buffer: <base64 of the whole
  buffer>, props }`** — the SAME shape the store codec writes to disk, so a live
  `Float64Array`-with-props and its on-disk encoding hash identically (that is
  what lets the codec-reviving app and the plain-JSON migration runner agree on
  an intrinsic id). Then SHA-256 of that string, truncated to 32 hex. The `id`
  field is advisory on import: the reader recomputes it from `inner` and warns
  on a mismatch.
- **`associations`** is the refcount: an empty list means the record is orphaned
  and its file is trashed. A record belongs to triple `T` when a binding has
  `tripleHash === T`, or (legacy/per-camera) no `tripleHash` and `cameraKey` is
  one of `T`'s live L/C/R cameras (extrinsic binds an eye; intrinsic binds the
  center).
- **Aggregation** (concatenate datasets → a new record with `sources`) is
  **extrinsic-only** — intrinsic records hold a solve, not a concatenable array.

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
  "exported": "2025-01-15T12:00:00.000Z",
  "record": {                      // associations STRIPPED
    "id": "<id>",
    "inner": { "kind": "extrinsic", "dataset": [ ... ] },  // or the intrinsic shape
    "created": "2025-01-01T00:00:00.000Z",
    "label": "optional",
    "sources": ["<id>"],           // if aggregated
    "role": "L"                    // "L" | "C" | "R", advisory — for re-binding on import
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
  "exported": "2025-01-15T12:00:00.000Z",
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
