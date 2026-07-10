# Calibration records v2

Status: CODE-COMPLETE (2026-07-10) — rig pass owed (see §Stage-F). Supersedes the
flat per-camera extrinsic dataset (`["calibrate-extrinsic", <cameraKey>]`) with a
content-addressed **record** model, adds triple nicknames + device-config
import/export, a records-management UI (aggregate / inspect / import / export /
discard), an extrinsic **visualizer** + live **overlay**, and a durable
**store-schema migration framework**.

This is the design rationale; the on-disk contract someone can hand-craft JSON
against lives in [`docs/schema/calibration-record.md`](../schema/calibration-record.md).

---

## 1. Data model — mutable outer / immutable inner + hash id

A calibration record splits its data by mutability:

- **Immutable inner data** (`ExtrinsicInner`): `{ kind: "extrinsic", dataset }`
  where `dataset` is the raw `ExtrinsicData[]` array captured by
  calibrate-extrinsic (image corners, object corners, voltage, angle, and the
  optional measured-magnification quads). This is the **hash pre-image**.
- **Mutable outer metadata** (`RecordMeta`): `{ created, label?, associations[],
  sources? }`. Editing it never changes the id.

The record **id** (its primary key AND store filename) is
`SHA-256(canonicalize(inner))`:

- `canonicalize` sorts object keys **recursively** (key order never affects the
  id) while preserving **array order** (datapoint order is significant), and
  omits `undefined`/absent optional fields identically. Pure + unit-tested for
  key-order / nesting / typed-value stability (`test/calibration-records.test.ts`).
- Same datapoints → same id, across sessions and platforms. An identical
  calibration imported from another rig **collides** with the local one, so
  import degrades to "add an association" rather than duplicating data.

Implementation: [`app/lib/calibration-records.ts`](../../app/lib/calibration-records.ts)
(pure — no store IO, no Vue, no `core/`). Records live under
`["calibration-records", <id>]`.

### Associations (camera-instance ⇄ triple bindings)

`associations: { cameraKey, tripleHash?, role? }[]`. A record may bind to many
camera instances across many triples (multi-association). A binding's identity is
the `(cameraKey, tripleHash)` pair. A record **belongs to** a triple `T` when it
has a binding with `tripleHash === T`, OR a legacy binding (no `tripleHash`)
whose `cameraKey` is one of `T`'s live L/R camera keys — so migrated records
surface under the connected rig without the migration needing to know live triple
hashes.

### Which record feeds the rig

`resolveActiveDataset(records, cameraKey)` returns the **latest** (`created`)
record bound to a camera; `loadExtrinsic` (orchestrator) uses it, falling back to
the legacy flat doc for an un-migrated store. calibrate-extrinsic's `confirm`
writes each eye's dataset as a record bound to the connected triple (identical
re-calibration just adds the association). History is additive; only the latest
bound record is "active".

---

## 2. Migration (zero data loss)

Legacy `["calibrate-extrinsic", <cameraKey>]` docs load losslessly:
`migrateLegacyExtrinsic` wraps the array as inner data verbatim, computes the
hash id, and synthesizes one `cameraKey` association with `created` from the
store file's mtime. Idempotent by construction (id is a pure function of the
dataset). `.raw`-suffixed extrinsic docs are analysis artifacts — left verbatim,
never migrated.

Run by the store-schema migration framework (below) at main boot; see
[`docs/schema/calibration-record.md`](../schema/calibration-record.md) for the
exact before/after layout.

---

## 3. Store-schema migration framework (durable)

`app/lib/store-migrations.ts` — the reusable part. MAIN owns the store
(692f0e3), so migrations run in `migrateStoreOnBoot`
([`app/electron/store-migrate.ts`](../../app/electron/store-migrate.ts)) **before
any client is served**.

- **Version marker**: reserved doc `["schema"]` → `{ version }`
  (`store/schema.json`). An unversioned tree = version 0.
- **Registry**: `MIGRATIONS` — an ordered `(from → to)` chain. `STORE_SCHEMA_VERSION`
  is the current target. Migration `0 → 1` = calibration-records-v2.
- **Boot flow**: read version → if behind, **snapshot** the store git repo
  (commit + best-effort push) → apply pending migrations in order → write the new
  version → snapshot again. Offline never blocks boot (push failures are logged).
  A store that is not a git repo skips snapshots with a warning but still
  migrates. A migration failure is logged (the pre-migration snapshot is the
  safety net) and does not crash boot.
- **The contract for the next contributor** (also stated at the registry): to
  evolve the schema, **append** a migration `{ from: N, to: N+1 }` and bump
  `STORE_SCHEMA_VERSION`; **never edit a shipped migration**. Write each step to
  converge (check-before-write / derive ids from content) so a re-run is a no-op.

The git snapshot boundary is an injected `SnapshotHook`, so the framework stays
pure + unit-tested (`test/store-migrations.test.ts`: version detection, ordered
application, idempotency, snapshot decisions, legacy-fixture 0→1). The real git
shell lives only in `store-migrate.ts`.

---

## 4. Import / export matrix

Both records and device-config offer **INTERNAL** (add an association to a target
triple, no file) and **EXTERNAL** (JSON on disk) modes.

| | Internal | External |
|---|---|---|
| **Record** | Import a JSON record into the selected triple → existing id **adds an association**, else **creates**; an inner-data mismatch on a colliding id is warned. | Export one record → `fovea-calibration-record@1` JSON (associations stripped, `role` advisory). |
| **Device config** | (Covered by external — a bundle applied to the selected triple.) | Export the per-triple config **with** its associated records attached, **associations stripped** → `fovea-device-config@1`. Import merges the config and re-associates each record to the selected triple; **cross-triple import prompts for a new nickname**. |

Decisions are pure (`decideImport`, `buildDeviceExport`, `buildRecordExport`,
`toRecordExport`); the config window performs the store IO + dialogs. File
dialogs + reads/writes go through main
(`showJsonSaveDialog`/`showJsonOpenDialog`/`writeTextFile`/`readTextFile`).

---

## 5. Aggregation

`aggregateRecords(records[])` concatenates the sources' datapoint arrays into a
**new** record (new hash id), records the source ids in `outer.sources`
(provenance), and takes the current-triple association so it surfaces
immediately. **Sources are never mutated.** Driven by multi-selection in the list.

---

## 6. Refcounted delete → OS trash

"Discard" removes the current triple's association(s) (`removeAssociations` +
`tripleAssociationMatcher`). When the association count hits 0 the record file
moves to the **OS trash** (`shell.trashItem` via main's `store:trash`; the
authority cache is cleared afterward) — never a hard delete, always recoverable.
The confirm prompt states whether a discard will trash (last association) or
merely unbind (other rigs still hold it).

---

## 7. Visualizer + live overlay

The visualizer is a **virtual stream** (no frame buffers). For each datapoint it
pairs OBSERVED corners (dots) with the pinhole solve's PROJECTED corners
(crosses) joined by an error segment; RMS + datapoint count head the legend.

- **Math** (`app/lib/calibration-visualizer.ts`, pure + core-free): reuses the
  EXISTING calibration construction from `findPinholeProjection` — `transformPoints`
  (rotate + perspective to the canonical frame) and `relativeToAbsolute` (place
  into image space at the fitted mean scale) — via the extracted core-free
  `app/lib/projection-geom.ts`. No camera math is reimplemented; it is the same
  construction the per-pose homography is fit to, stopped one step earlier
  (observed vs projected target). Unit-tested against a synthetic identity
  calibration (scaled + translated marker at zero angle → zero residual;
  `test/calibration-visualizer.test.ts`).
- **Shared renderer, two hosts**: `CalibrationMarks.vue` renders the marks ONLY
  (an `<g>` in sensor-pixel space). `CalibrationVisualizer.vue` wraps it in a
  viewBox'd `<svg>` + legend for the Settings "Inspect" panel; the live
  calibrate-extrinsic view mounts the SAME `CalibrationMarks` inside a
  `StreamView` slot (whose coordinates are already sensor pixels).
- **Overlay toggle**: rides a main-backed store doc `["ui", "cal-overlay"]`
  (`app/lib/calibration-overlay.ts`) → live cross-window. Toggling from a record
  entry sets `{ recordId, cameraKey, role }`; the calibrate-extrinsic view draws
  the record's marks over the L/R stream whose role matches.

---

## 8. AS-BUILT deltas

- **Load path NOT unified into "active record selection".** `loadExtrinsic` uses
  the LATEST record bound to a camera (matches the prior one-dataset-per-camera
  semantics) with a legacy-doc fallback. Choosing among multiple bound records
  per camera from the UI is deferred (history is additive today).
- **Legacy association binds by `cameraKey` only** (no live triple hash at
  migration time). The UI matches such records to the connected triple by live
  L/R keys; a disconnected triple only shows explicitly hash-bound records.
- **Sensor aspect**: the visualizer uses the point bounding box (no sensor size
  is threaded through yet); `viewBoxFor` accepts a sensor size for the day it is.
- **Device-config INTERNAL import** is folded into the external bundle path (a
  bundle applied to the selected triple); there is no separate no-file
  device-config transfer between two live triples in this pass.

---

## Stage-F (rig pass owed)

- Nickname in the selector + Welcome against a real connected rig.
- Device import/export round-trip incl. the cross-triple nickname prompt.
- Refcount → trash (verify the file lands in the OS trash and is recoverable).
- Aggregation of real records; confirm `loadExtrinsic` picks the latest.
- Visualizer against a REAL extrinsic calibration (residuals read sensibly).
- Live overlay on the rig (toggle in Settings, see it on the calibrate-extrinsic
  L/R streams).
- Confirm the boot migration ran once on the real store and is a no-op thereafter.
