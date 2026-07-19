<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Settings window body (async; mounted under ConfigWindow's <Suspense>). Fixed
  tab header + two tabs: GLOBAL config (bound to the shared `["config"]` doc via
  `useConfigRef` so edits apply live across windows) and per-triple DEVICE config
  (overrides + the full calibration-data inventory, so orphaned entries for
  disconnected rigs stay reachable; the connected rig is selected by default).
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRaw, watch } from "vue";
import Store from "@lib/store";
import { wireEncode } from "@lib/store-codec";
import { getCameraKey } from "@lib/camera-config";
import { useConfigRef } from "@lib/config";
import { anaglyphCards, type AnaglyphStyle } from "../../../docs/schema/anaglyph";
import {
  DEFAULT_TELECANVAS_PORT,
  IDLE_TELECANVAS_STATUS,
  type TeleCanvasStatus,
} from "@lib/telecanvas";
import {
  enumerateCalibrationData,
  deleteCalibrationEntry,
  enumerateRecords,
  recordsForTriple,
  connectedEyeKeys,
  recordRow,
  categoryTitle,
  resolveBaseline,
  connectedTripleHash,
  orderTriples,
  defaultTripleSelection,
  type CalStore,
  type CalEntry,
  type CalCategory,
  type KnownCamera,
  type TripleConfig,
} from "@lib/calibration-data";
import {
  recordStore,
  addAssociation,
  aggregateRecords,
  buildDeviceExport,
  buildRecordExport,
  decideImport,
  removeAssociations,
  tripleAssociationMatcher,
  makeRecord,
  recordId,
  type CalibrationRecord,
  type RecordInner,
  type DeviceExportFile,
  type RecordExportFile,
  DEVICE_EXPORT_SCHEMA,
  RECORD_EXPORT_SCHEMA,
} from "@lib/calibration-records";
import {
  OVERLAY_DOC,
  OVERLAY_OFF,
  overlayActiveFor,
  type OverlayState,
} from "@lib/calibration-overlay";
import CalibrationVisualizer from "../components/CalibrationVisualizer.vue";
import type { ProbeCamera } from "@lib/orchestrator/probe";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faArrowsRotate, faChevronDown } from "./icons";
import {
  faTrash,
  faCopy,
  faCheck,
  faPlug,
  faMagnifyingGlass,
  faFileExport,
  faFileImport,
  faLayerGroup,
  faEye,
} from "@fortawesome/free-solid-svg-icons";

// ---- Tabs (fixed header; only the content below scrolls) -------------------
type Tab = "global" | "device";
const activeTab = ref<Tab>("global");
// One shared scroller hosts both v-show sections (preserves expanded/transient
// state across switches) — reset it on tab change so Device doesn't open
// pre-scrolled to Global's offset.
const tabContent = ref<HTMLElement | null>(null);
watch(activeTab, () => tabContent.value?.scrollTo({ top: 0 }));

// ---- App-level config (live, writable refs over the shared document) --------
const default_save_dir = await useConfigRef("default_save_dir");
const record_compression = await useConfigRef("record_compression");
const tele_canvas_mode = await useConfigRef("tele_canvas_mode");
const tele_canvas_url = await useConfigRef("tele_canvas_url");
const tele_canvas_port = await useConfigRef("tele_canvas_port");
// App-level baseline fallback: the baseline is a per-TRIPLE setting. Kept here
// only to show the effective FALLBACK value in a triple's baseline hint when
// that triple has no override.
const baseline_distance_mm = await useConfigRef("baseline_distance_mm");
const cal_marker_size_mm = await useConfigRef("cal_marker_size_mm");
const cal_marker_ratio = await useConfigRef("cal_marker_ratio");
// Anaglyph style: live-writable ref over the shared
// config doc. The card view-models (label + literal swatch colors + selection)
// come from the SHARED `docs/schema/anaglyph` helper so the cards render the
// exact same truth the viewer/native brick compose. Clicking a card writes the
// style — applies live (disparity-scope center Anaglyph view + viewer 3D).
const anaglyph_style = await useConfigRef("anaglyph_style");
// GLOBAL prediction rate (Hz) driving the native IMM brick's feed-forward emit
// rate. Same doc key the disparity-scope drawer slider binds — edits here
// apply live across windows.
const prediction_rate_hz = await useConfigRef("prediction_rate_hz");
// Serial-latency compensation: adds the measured one-way serial latency to the
// predictor's fixed lookahead. Default OFF; Settings-only (no drawer control).
const serial_latency_comp = await useConfigRef("serial_latency_comp");
// Auto-close a projection window once ALL its panes have terminated.
// Default ON.
const projection_auto_close = await useConfigRef("projection_auto_close");
// Profiler node-graph hover-card behavior. Same doc key the profiler window
// reads live over the shared config doc.
const profiler_hover_card = await useConfigRef("profiler_hover_card");
const anaglyphCardList = computed(() => anaglyphCards(anaglyph_style.value));
function selectAnaglyph(style: AnaglyphStyle): void {
  anaglyph_style.value = style;
}

// ---- TeleCanvas host status (main-owned server; host mode) -----------------
const teleIsHost = computed(() => (tele_canvas_mode.value ?? "client") === "host");
// Presentation-only URL validity (client mode): empty = disabled (not invalid);
// a non-empty unparseable string gets the `.invalid` underline. No push effect.
const teleUrlInvalid = computed(() => {
  const u = (tele_canvas_url.value ?? "").trim();
  if (!u) return false;
  try {
    new URL(u);
    return false;
  } catch {
    return true;
  }
});
const teleStatus = ref<TeleCanvasStatus>(IDLE_TELECANVAS_STATUS);
let disposeTele: (() => void) | null = null;
const teleCopied = ref<string | null>(null);
async function copyTeleUrl(u: string) {
  try {
    await navigator.clipboard.writeText(u);
    teleCopied.value = u;
    setTimeout(() => {
      if (teleCopied.value === u) teleCopied.value = null;
    }, 1200);
  } catch {
    /* clipboard unavailable */
  }
}
// Nudge main with the full push target on any mode/port/url change (+ once on
// open). Main reconciles the host process AND re-broadcasts {mode, url, port} to
// every window so app-window pushers in OTHER orchestrator instances follow.
watch(
  () =>
    [
      tele_canvas_mode.value ?? "client",
      tele_canvas_port.value ?? DEFAULT_TELECANVAS_PORT,
      tele_canvas_url.value ?? "",
    ] as const,
  ([m, p, u]) => window.foveaBridge.applyTeleCanvas(m, p, u),
  { immediate: true },
);

// Live writability check for the save dir (empty = auto, always OK).
const saveDirValid = ref(true);
async function checkSaveDir() {
  const v = (default_save_dir.value ?? "").trim();
  saveDirValid.value = v === "" ? true : await window.foveaBridge.validateWritablePath(v);
}
void checkSaveDir();

// ---- Known cameras (friendly names) ----------------------------------------
const cameras = ref<KnownCamera[]>([]);
let disposeProbe: (() => void) | null = null;

// ---- Calibration data enumeration ------------------------------------------
const calStore: CalStore = {
  list: (...s) => Store.list(...s),
  read: (s, f) => Store.read(s, f),
  clear: (...s) => Store.clear(...s),
};

const entries = ref<CalEntry[]>([]);
const loading = ref(false);
// The hash of the currently-connected rig (one camera each of role L/C/R), or
// null when no complete rig is plugged in — the Device tab's default selection.
const connectedKey = ref<string | null>(null);

async function refresh() {
  loading.value = true;
  try {
    entries.value = await enumerateCalibrationData(calStore, cameras.value);
    connectedKey.value = await connectedTripleHash(cameras.value);
    await refreshRecords();
    await refreshNicknames();
  } finally {
    loading.value = false;
  }
}

const grouped = computed(() => {
  const order: CalCategory[] = ["triples", "calibrate-intrinsic", "calibrate-extrinsic"];
  return order
    .map((category) => ({
      category,
      title: categoryTitle(category),
      items: entries.value.filter((e) => e.category === category),
    }))
    .filter((g) => g.items.length > 0);
});

const entryId = (e: CalEntry) => `${e.category}/${e.key}`;

// ---- Device-config triple selection ----------------------------------------
// The configured triples, connected-first (pure ordering — see
// `@lib/calibration-data`). The selector + default resolution consume this.
const orderedTriples = computed(() => orderTriples(entries.value, connectedKey.value));
const selectedTripleKey = ref<string | null>(null);
const selectedTriple = computed(
  () => orderedTriples.value.find((t) => t.key === selectedTripleKey.value) ?? null,
);
const tripleDialogOpen = ref(false);

// Reactive triple docs, opened lazily on selection. `Store.open` returns a
// reactive object; mutating one field re-persists the WHOLE document, so
// drift_l/drift_r (and any other field) are preserved.
const tripleDocs = ref<Record<string, TripleConfig>>({});

async function openTripleDoc(key: string) {
  if (!(key in tripleDocs.value))
    tripleDocs.value[key] = await Store.open<TripleConfig>(["triples", key]);
}

// Keep the selection valid: default to the connected rig (else the first
// triple) whenever the current selection disappears or was never made.
watch(
  orderedTriples,
  (list) => {
    if (selectedTripleKey.value && list.some((t) => t.key === selectedTripleKey.value))
      return;
    selectedTripleKey.value = defaultTripleSelection(list)?.key ?? null;
  },
  { immediate: true },
);
// Record multi-selection — declared BEFORE the immediate watcher below, which
// clears it on triple switch (an immediate watcher runs at setup: referencing a
// later `const` hits the temporal dead zone, rejects the async setup, and spins
// the Suspense forever).
const selectedIds = ref<Set<string>>(new Set());
// Open the selected triple's reactive doc so the per-triple fields bind to it.
watch(
  selectedTripleKey,
  (key) => {
    // A record selection never survives a triple switch — a stale set left the
    // "Aggregate N" header button live while aggregateSelected() filtered to
    // the NEW triple's records and silently no-opped.
    selectedIds.value = new Set();
    if (key) void openTripleDoc(key);
  },
  { immediate: true },
);

function selectTriple(key: string) {
  selectedTripleKey.value = key;
  tripleDialogOpen.value = false; // instant close (no fade)
}

/** Read a triple's current zoom_override (0 / absent = none). */
function zoomOf(key: string): number {
  const v = tripleDocs.value[key]?.zoom_override;
  return typeof v === "number" ? v : 0;
}
/** Write a triple's zoom_override: 0/blank CLEARS the field, >0 stores it — the
 *  doc's other fields (drift_l/drift_r) ride along untouched on re-persist. */
function setZoom(key: string, value: number) {
  const doc = tripleDocs.value[key];
  if (!doc) return;
  if (!value || value <= 0) delete doc.zoom_override;
  else doc.zoom_override = value;
}

/** Read a triple's baseline_mm override (0 / absent = none → use app default). */
function baselineOf(key: string): number {
  const v = tripleDocs.value[key]?.baseline_mm;
  return typeof v === "number" ? v : 0;
}
/** Write a triple's baseline_mm: 0/blank CLEARS the field (fall back to the app
 *  default), >0 stores it — other fields ride along untouched on re-persist. */
function setBaseline(key: string, value: number) {
  const doc = tripleDocs.value[key];
  if (!doc) return;
  if (!value || value <= 0) delete doc.baseline_mm;
  else doc.baseline_mm = value;
}
/** The effective baseline (mm) a triple with NO override falls back to — the
 *  legacy app value, else 200 (the SHARED `resolveBaseline` rule). Shown in the
 *  empty-field hint so the operator sees the number the rig will actually use. */
const effectiveBaselineFallback = computed(() =>
  resolveBaseline(undefined, baseline_distance_mm.value),
);

/** Read a triple's trigger settle hold — stored in µs (protocol units), edited
 *  here in ms (0 / absent = no hold). */
function settleMsOf(key: string): number {
  const v = tripleDocs.value[key]?.settle_time_us;
  return typeof v === "number" ? v / 1000 : 0;
}
/** Write a triple's settle hold: 0/blank CLEARS the field (no hold), >0 stores
 *  it in µs — other fields ride along untouched on re-persist. Applies at the
 *  NEXT multi-fovea session start (config docs are per-instance; the drawer
 *  slider is the live override for a running session). */
function setSettleMs(key: string, ms: number) {
  const doc = tripleDocs.value[key];
  if (!doc) return;
  if (!ms || ms <= 0) delete doc.settle_time_us;
  else doc.settle_time_us = Math.round(ms * 1000);
}

/** Read a triple's tracking-chain delay compensation (ms, SIGNED; 0/absent =
 *  off). Unlike the others this may be negative (a retrodiction). */
function delayOf(key: string): number {
  const v = tripleDocs.value[key]?.delay_compensation_ms;
  return typeof v === "number" ? v : 0;
}
/** Write a triple's delay compensation: 0/blank CLEARS the field (off), any
 *  other finite value (incl. negative) stores it — other fields ride along on
 *  re-persist. Applies at the NEXT Disparity Scope session start (config docs
 *  are per-instance). */
function setDelay(key: string, ms: number) {
  const doc = tripleDocs.value[key];
  if (!doc) return;
  if (!ms || !Number.isFinite(ms)) delete doc.delay_compensation_ms;
  else doc.delay_compensation_ms = ms;
}

// ---- Two-step delete confirm -----------------------------------------------
const confirming = ref<string | null>(null);

function askDelete(e: CalEntry) {
  confirming.value = entryId(e);
}
function cancelDelete() {
  confirming.value = null;
}
async function doDelete(e: CalEntry) {
  await deleteCalibrationEntry(calStore, e);
  confirming.value = null;
  delete tripleDocs.value[e.key];
  // Dropping the selected triple's doc → let the watcher re-resolve a default.
  if (e.category === "triples" && selectedTripleKey.value === e.key)
    selectedTripleKey.value = null;
  await refresh();
}

// ---- Per-triple NICKNAME (calibration-records-v2) --------------------------
/** Read a triple's nickname (empty = none). Rides the reactive triple doc. */
function nicknameOf(key: string): string {
  const v = tripleDocs.value[key]?.nickname;
  return typeof v === "string" ? v : "";
}
/** Write a triple's nickname: blank CLEARS it, else stores the trimmed value —
 *  other fields ride along untouched on re-persist. Commit on @change so an
 *  in-progress space isn't stored mid-type. */
function setNickname(key: string, value: string): void {
  const doc = tripleDocs.value[key];
  if (!doc) return;
  const t = value.trim();
  if (!t) delete doc.nickname;
  else doc.nickname = t;
  nicknames.value = { ...nicknames.value, [key]: t };
}

// ---- Calibration records (list, aggregate, inspect, import/export) ---------
const records = ref<CalibrationRecord[]>([]);
// Per-triple nicknames for the selector dialog (read for every triple, not just
// the selected one whose doc is opened reactively).
const nicknames = ref<Record<string, string>>({});
const inspecting = ref<CalibrationRecord | null>(null);
const message = ref<string | null>(null);
const confirmDiscardId = ref<string | null>(null);
const confirmClearDevice = ref(false);
// Cross-window overlay toggle — a main-backed doc so the calibrate-extrinsic
// view (or any StreamView) shows the overlay live when it targets its camera.
const overlayState = await Store.open<OverlayState, OverlayState>(OVERLAY_DOC, {
  ...OVERLAY_OFF,
});
// Pending device-config import awaiting a cross-triple nickname.
const pendingDeviceImport = ref<{ bundle: DeviceExportFile; nickname: string } | null>(null);

function notify(msg: string): void {
  message.value = msg;
  setTimeout(() => {
    if (message.value === msg) message.value = null;
  }, 3200);
}

/** The live L/R camera keys of the selected triple (only when it is the
 *  connected rig — a disconnected triple can't resolve its camera keys, so
 *  legacy cameraKey-bound records only surface on the connected rig). */
const liveKeys = computed<string[]>(() =>
  selectedTriple.value?.connected ? connectedEyeKeys(cameras.value) : [],
);
/** Records bound to the selected triple, latest-first. */
const tripleRecords = computed<CalibrationRecord[]>(() =>
  selectedTripleKey.value
    ? recordsForTriple(records.value, selectedTripleKey.value, liveKeys.value)
    : [],
);
const recordRows = computed(() => tripleRecords.value.map(recordRow));
const selectedCount = computed(() => selectedIds.value.size);
// Aggregate is EXTRINSIC-only (intrinsic solves aren't concatenable) and never
// crosses kinds — the header button gates on an all-extrinsic selection.
const selectedAllExtrinsic = computed(() => {
  const sel = tripleRecords.value.filter((r) => selectedIds.value.has(r.id));
  return sel.length >= 2 && sel.every((r) => r.inner.kind === "extrinsic");
});
// The inspect visualizer is extrinsic-only — its dataset, or null for intrinsic.
const inspectDataset = computed(() =>
  inspecting.value?.inner.kind === "extrinsic" ? inspecting.value.inner.dataset : null,
);

async function refreshRecords(): Promise<void> {
  records.value = await enumerateRecords(calStore);
  selectedIds.value = new Set(); // selection is index-fragile across a reload
}

/** Read every triple's nickname (for the selector dialog). */
async function refreshNicknames(): Promise<void> {
  const map: Record<string, string> = {};
  for (const t of orderedTriples.value) {
    const doc = await Store.read<TripleConfig>(["triples", t.key], {});
    if (typeof doc.nickname === "string" && doc.nickname.trim())
      map[t.key] = doc.nickname.trim();
  }
  nicknames.value = map;
}

/** Persist a full record doc (whole-doc replace through main; wire-encoded —
 *  record datasets may carry Mats whose attached props structured clone
 *  strips, see store-codec wire framing). */
function writeRecord(rec: CalibrationRecord): Promise<void> {
  return window.foveaBridge.patchStore(
    [recordStore(rec.inner.kind), rec.id],
    wireEncode([{ replace: rec }]),
  );
}

function toggleSelect(id: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

/** The camera key an association to the selected triple should use for `role`:
 *  the live eye camera when connected, else a synthetic triple-scoped key (so a
 *  disconnected-target import still binds + surfaces via the triple hash). */
function eyeKeyForRole(role?: string): string {
  if (role && selectedTriple.value?.connected) {
    const cam = cameras.value.find((c) => c.role === role);
    if (cam) return getCameraKey(cam);
  }
  return `${selectedTripleKey.value}:${role ?? "?"}`;
}

/** Would discarding this record from the selected triple orphan it (→ trash)? */
function wouldOrphan(rec: CalibrationRecord): boolean {
  if (!selectedTripleKey.value) return false;
  return removeAssociations(
    rec,
    tripleAssociationMatcher(selectedTripleKey.value, liveKeys.value),
  ).orphaned;
}

async function doDiscardRecord(rec: CalibrationRecord): Promise<void> {
  confirmDiscardId.value = null;
  if (!selectedTripleKey.value) return;
  // A discarded record must not stay overlaid: the toggle row disappears from
  // the list with it, leaving the live view stuck with no affordance to turn
  // the marks off.
  if (overlayState.recordId === rec.id) Object.assign(overlayState, OVERLAY_OFF);
  const { record, orphaned } = removeAssociations(
    rec,
    tripleAssociationMatcher(selectedTripleKey.value, liveKeys.value),
  );
  if (orphaned) {
    // Refcount hit 0 → move the file to the OS trash (recoverable).
    await window.foveaBridge.trashStoreDoc([recordStore(rec.inner.kind), rec.id]);
  } else {
    await writeRecord(record);
  }
  await refreshRecords();
}

async function aggregateSelected(): Promise<void> {
  const sel = tripleRecords.value.filter((r) => selectedIds.value.has(r.id));
  if (sel.length < 2 || !selectedTripleKey.value) return;
  // Never aggregate across kinds — and only extrinsic records aggregate at all
  // (intrinsic solves aren't a concatenable capture array). The header button is
  // already gated to extrinsic-only selections; guard here too.
  if (sel.some((r) => r.inner.kind !== "extrinsic")) {
    notify("Only extrinsic records can be aggregated.");
    return;
  }
  const first = sel[0]!.outer.associations[0];
  const agg = await aggregateRecords(sel, {
    created: new Date().toISOString(),
    label: `Aggregate of ${sel.length}`,
    association: {
      cameraKey: first?.cameraKey ?? eyeKeyForRole(first?.role),
      tripleHash: selectedTripleKey.value,
      role: first?.role,
    },
  });
  await writeRecord(agg);
  await refreshRecords();
}

async function exportRecord(rec: CalibrationRecord): Promise<void> {
  const path = await window.foveaBridge.showJsonSaveDialog(`calibration-${rec.id.slice(0, 8)}`);
  if (!path) return;
  const file = buildRecordExport(rec, new Date().toISOString());
  await window.foveaBridge.writeTextFile(path, JSON.stringify(file, null, 2));
  notify("Record exported.");
}

async function importRecordFile(): Promise<void> {
  if (!selectedTripleKey.value) return;
  const path = await window.foveaBridge.showJsonOpenDialog();
  if (!path) return;
  const text = await window.foveaBridge.readTextFile(path);
  if (!text) return;
  let file: RecordExportFile;
  try {
    file = JSON.parse(text);
  } catch {
    notify("Not valid JSON.");
    return;
  }
  if (file.schema !== RECORD_EXPORT_SCHEMA || !file.record) {
    notify("Not a calibration-record file.");
    return;
  }
  const mismatch = await importOneRecord(file.record);
  await refreshRecords();
  notify(
    mismatch
      ? "Record imported — WARNING: an existing record shares this id but its data differs."
      : "Record imported.",
  );
}

/** Import one record (external file or device bundle) into the selected triple:
 *  existing id → add an association; else create. Warns on an inner-data
 *  mismatch (corrupt bundle). */
async function importOneRecord(incoming: RecordExportFile["record"]): Promise<boolean> {
  // Look up by the RECOMPUTED id (never trust the file's declared id) so a
  // corrupt bundle can't clobber an unrelated record. Returns whether an
  // inner-data mismatch was detected — the CALLER folds it into its toast (a
  // notify here was overwritten by the bundle path's success toast and never
  // seen).
  const trueId = await recordId(incoming.inner);
  const dir = recordStore((incoming.inner as RecordInner).kind);
  const existing = await Store.read<CalibrationRecord | null>([dir, trueId], null);
  const decision = await decideImport(incoming, existing?.inner ? existing : null);
  const assoc = {
    cameraKey: eyeKeyForRole(incoming.role),
    tripleHash: selectedTripleKey.value ?? undefined,
    role: incoming.role,
  };
  if (decision.action === "associate" && existing) {
    await writeRecord(addAssociation(existing, assoc));
  } else {
    const rec = await makeRecord(incoming.inner, {
      created: incoming.created ?? new Date().toISOString(),
      label: incoming.label,
      sources: incoming.sources,
      associations: [assoc],
    });
    await writeRecord(rec);
  }
  return decision.dataMismatch === true;
}

// ---- Device-config import / export / clear ---------------------------------
async function exportDevice(): Promise<void> {
  if (!selectedTripleKey.value) return;
  const doc = tripleDocs.value[selectedTripleKey.value];
  const config = doc ? { ...toRaw(doc) } : {};
  const bundle = buildDeviceExport(config, tripleRecords.value, {
    now: new Date().toISOString(),
    sourceTripleHash: selectedTripleKey.value,
  });
  const name = `device-${nicknames.value[selectedTripleKey.value] || selectedTripleKey.value.slice(0, 8)}`;
  const path = await window.foveaBridge.showJsonSaveDialog(name.replace(/\s+/g, "-"));
  if (!path) return;
  await window.foveaBridge.writeTextFile(path, JSON.stringify(bundle, null, 2));
  notify("Device config exported (with associated records).");
}

async function importDevice(): Promise<void> {
  if (!selectedTripleKey.value) return;
  const path = await window.foveaBridge.showJsonOpenDialog();
  if (!path) return;
  const text = await window.foveaBridge.readTextFile(path);
  if (!text) return;
  let bundle: DeviceExportFile;
  try {
    bundle = JSON.parse(text);
  } catch {
    notify("Not valid JSON.");
    return;
  }
  if (bundle.schema !== DEVICE_EXPORT_SCHEMA) {
    notify("Not a device-config file.");
    return;
  }
  const crossTriple =
    !!bundle.sourceTripleHash && bundle.sourceTripleHash !== selectedTripleKey.value;
  if (crossTriple) {
    // Importing another rig's config → prompt for a fresh nickname.
    pendingDeviceImport.value = { bundle, nickname: "" };
    return;
  }
  await applyDeviceImport(bundle, (bundle.config.nickname as string | undefined) ?? undefined);
}

async function confirmDeviceImport(): Promise<void> {
  const p = pendingDeviceImport.value;
  if (!p) return;
  await applyDeviceImport(p.bundle, p.nickname.trim() || undefined);
  pendingDeviceImport.value = null;
}

async function applyDeviceImport(
  bundle: DeviceExportFile,
  nickname: string | undefined,
): Promise<void> {
  const key = selectedTripleKey.value;
  if (!key) return;
  await openTripleDoc(key);
  const doc = tripleDocs.value[key];
  if (doc) {
    const cfg: Record<string, unknown> = { ...bundle.config, nickname };
    for (const [k, v] of Object.entries(cfg)) {
      if (v === undefined || v === "") delete (doc as Record<string, unknown>)[k];
      else (doc as Record<string, unknown>)[k] = v;
    }
  }
  let mismatches = 0;
  for (const r of bundle.records) if (await importOneRecord(r)) mismatches++;
  await refresh();
  // One toast carries everything — a per-record warning toast was overwritten
  // by this success toast and never seen.
  notify(
    `Imported device config (${bundle.records.length} record${bundle.records.length === 1 ? "" : "s"})` +
      (mismatches ? ` — WARNING: ${mismatches} with a data mismatch.` : "."),
  );
}

async function doClearDevice(): Promise<void> {
  confirmClearDevice.value = false;
  const key = selectedTripleKey.value;
  if (!key) return;
  const doc = tripleDocs.value[key];
  if (!doc) return;
  for (const k of Object.keys(doc)) delete (doc as Record<string, unknown>)[k];
  nicknames.value = { ...nicknames.value, [key]: "" };
  notify("Device settings reset to defaults.");
}

// ---- Inspect + live overlay ------------------------------------------------
function inspectRecord(rec: CalibrationRecord): void {
  // The observed-vs-projected visualizer is extrinsic-only.
  if (rec.inner.kind !== "extrinsic") return;
  inspecting.value = rec;
}
function overlayOn(rec: CalibrationRecord): boolean {
  return overlayActiveFor(overlayState, rec.outer.associations[0]?.cameraKey ?? "") &&
    overlayState.recordId === rec.id;
}
function toggleOverlay(rec: CalibrationRecord): void {
  if (overlayState.recordId === rec.id) {
    overlayState.recordId = null;
    overlayState.cameraKey = null;
    overlayState.role = null;
  } else {
    overlayState.recordId = rec.id;
    overlayState.cameraKey = rec.outer.associations[0]?.cameraKey ?? null;
    overlayState.role = rec.outer.associations[0]?.role ?? null;
  }
}

onMounted(async () => {
  disposeProbe = window.foveaBridge.onProbeCameras((list: ProbeCamera[]) => {
    cameras.value = list;
    // Re-resolve friendly names when the known cameras change.
    void refresh();
  });
  try {
    teleStatus.value = await window.foveaBridge.getTeleCanvasStatus();
  } catch {
    /* keep idle default */
  }
  disposeTele = window.foveaBridge.onTeleCanvasStatus((s) => (teleStatus.value = s));
  void refresh();
});
onUnmounted(() => {
  disposeProbe?.();
  disposeTele?.();
});
</script>

<template>
  <div class="config-root">
    <!-- Fixed tab header — never scrolls out of view (only .tab-content does).
         Tab switch is instant (no fade/slide). -->
    <div class="tabs" role="tablist" aria-label="Settings sections">
      <button
        role="tab"
        :aria-selected="activeTab === 'global'"
        class="tab"
        :class="{ active: activeTab === 'global' }"
        @click="activeTab = 'global'"
      >
        Global config
      </button>
      <button
        role="tab"
        :aria-selected="activeTab === 'device'"
        class="tab"
        :class="{ active: activeTab === 'device' }"
        @click="activeTab = 'device'"
      >
        Device config
      </button>
    </div>

    <div class="tab-content" ref="tabContent">
      <!-- ============ GLOBAL config ============ -->
      <section v-show="activeTab === 'global'">
      <h2>Application</h2>

      <label class="row" title="Base folder for captures & recordings. Empty = auto (external drive, else ~/Downloads). Red underline = not writable. New destinations only.">
        <span class="label">Default save directory</span>
        <input
          type="text"
          :class="{ invalid: !saveDirValid }"
          v-model="default_save_dir"
          placeholder="auto (external drive or ~/Downloads)"
          @input="checkSaveDir"
        />
      </label>

      <label class="row" title="zlib is lossless and plays back like raw, but may drop frames at full-rate 12-bit on all three cameras (drops shown in the record button's hover). New recordings only; running ones keep their method.">
        <span class="label">Recording compression</span>
        <span class="field">
          <select v-model="record_compression">
            <option value="none">None (raw)</option>
            <option value="zlib">zlib (lossless)</option>
          </select>
        </span>
      </label>

      <label class="row">
        <span class="label">TeleCanvas mode</span>
        <span class="field">
          <select v-model="tele_canvas_mode">
            <option value="client">Client (push to remote)</option>
            <option value="host">Host (serve locally)</option>
          </select>
        </span>
      </label>

      <label v-if="!teleIsHost" class="row" title="The app's windows push their projection here. Empty = disabled. Applies live.">
        <span class="label">TeleCanvas server URL</span>
        <input
          type="text"
          :class="{ invalid: teleUrlInvalid }"
          v-model="tele_canvas_url"
          placeholder="empty = disabled"
        />
      </label>

      <label v-else class="row" title="Open a listed URL on a TV or tablet on the same network to see the live projection. Applies live.">
        <span class="label">TeleCanvas server port</span>
        <span class="field">
          <input type="number" step="1" min="1" max="65535" v-model.number="tele_canvas_port" />
        </span>
      </label>
      <ul v-if="teleIsHost && teleStatus.listening && teleStatus.urls.length" class="tele-urls">
        <li v-for="u in teleStatus.urls" :key="u">
          <span class="u-text" :title="u">{{ u }}</span>
          <button
            class="icon-button"
            :title="teleCopied === u ? 'Copied' : 'Copy'"
            @click="copyTeleUrl(u)"
          >
            <Icon :icon="teleCopied === u ? faCheck : faCopy" />
          </button>
        </li>
      </ul>
      <p v-else-if="teleIsHost && teleStatus.error" class="hint err">{{ teleStatus.error }}</p>

      <label class="row" title="Applies live to open Extrinsic / Drift calibration windows.">
        <span class="label">Calibration marker size</span>
        <span class="field">
          <input type="number" step="1" min="1" v-model.number="cal_marker_size_mm" />
          <span class="unit">mm</span>
        </span>
      </label>

      <label class="row" title="Inner/outer marker diameter ratio. Applies live.">
        <span class="label">Calibration marker ratio</span>
        <span class="field">
          <input
            type="number"
            step="0.01"
            min="0.1"
            max="2"
            v-model.number="cal_marker_ratio"
          />
          <span class="unit">×</span>
        </span>
      </label>

      <div class="stacked-row">
        <span class="label" title="Left/right eye colors for the anaglyph 3D view. Applies live to Disparity Scope's Anaglyph view and the viewer's 3D mode.">Anaglyph style</span>
        <div class="anaglyph-cards" role="group" aria-label="Anaglyph style">
          <button
            v-for="card in anaglyphCardList"
            :key="card.style"
            type="button"
            class="anaglyph-card"
            :class="{ selected: card.selected }"
            :aria-pressed="card.selected"
            :title="`Left ${card.leftColor}, right ${card.rightColor}`"
            @click="selectAnaglyph(card.style)"
          >
            <!-- Swatch halves = the RESOLVED channel colors (content, not
                 palette tokens) — what the compose actually paints, should a
                 future style's eyes ever share a channel. -->
            <span class="swatch" aria-hidden="true">
              <span class="half" :style="{ backgroundColor: card.leftCss }">L</span>
              <span class="half" :style="{ backgroundColor: card.rightCss }">R</span>
            </span>
            <span class="card-name">{{ card.label }}</span>
          </button>
        </div>
      </div>

      <label class="row" title="Motion-predictor output rate for the mirror feed-forward. Applies live to Disparity Scope; also on its drawer.">
        <span class="label">Prediction rate</span>
        <span class="field">
          <input
            type="number"
            step="10"
            min="60"
            max="1000"
            v-model.number="prediction_rate_hz"
          />
          <span class="unit">Hz</span>
        </span>
      </label>

      <label class="row" title="Adds the measured one-way serial latency to the predictor's lookahead. Off = fixed lookahead only. Applies live.">
        <span class="label">Serial latency compensation</span>
        <span class="field">
          <input type="checkbox" v-model="serial_latency_comp" />
        </span>
      </label>

      <label class="row" title="Closes a projection window once all its streams end (after the ~10 s rebind grace). Off keeps it open with frozen last frames. Applies live.">
        <span class="label">Auto-close empty projections</span>
        <span class="field">
          <input type="checkbox" v-model="projection_auto_close" />
        </span>
      </label>

      <label class="row" title="Where the pipeline-graph hover card sits. Applies live to an open Profiler.">
        <span class="label">Profiler hover card</span>
        <span class="field">
          <select v-model="profiler_hover_card">
            <option value="follow">Follow cursor</option>
            <option value="corner">Snap to corner</option>
          </select>
        </span>
      </label>
      </section>

      <!-- ============ DEVICE config (per-triple) ============ -->
      <section v-show="activeTab === 'device'">
        <h2>Device configuration</h2>

        <!-- Triple selector: the FIRST item. Opens a centered modal list of
             every configured triple; the connected rig is badged + default. -->
        <div class="row selector-row">
          <span class="label">Triple</span>
          <button
            class="triple-select"
            :disabled="orderedTriples.length === 0"
            :title="orderedTriples.length === 0 ? 'No triples configured' : 'Editing an unplugged rig saves to its stored config'"
            @click="tripleDialogOpen = true"
          >
            <Icon
              v-if="selectedTriple?.connected"
              :icon="faPlug"
              class="conn-icon"
              title="Connected rig"
            />
            <span class="sel-label">{{
              selectedTriple
                ? nicknames[selectedTriple.key] || selectedTriple.label
                : "No triples configured"
            }}</span>
            <span v-if="selectedTriple && !selectedTriple.connected" class="disc-chip"
              >not connected</span
            >
            <Icon :icon="faChevronDown" class="caret" />
          </button>
        </div>

        <!-- Per-triple overrides for the SELECTED triple ------------------- -->
        <template v-if="selectedTripleKey">
          <label class="row" title="Shown in the triple picker and in Welcome when this rig is connected. Empty falls back to the camera serials. Applies live.">
            <span class="label">Nickname</span>
            <input
              type="text"
              class="nickname-input"
              placeholder="optional (shown in the picker &amp; Welcome)"
              :value="nicknameOf(selectedTripleKey)"
              @change="
                (ev) =>
                  setNickname(selectedTripleKey!, (ev.target as HTMLInputElement).value)
              "
            />
          </label>

          <label class="row" title="0 uses the calibration-measured magnification. Drives Disparity Scope's Auto match zoom at the next session start.">
            <span class="label">Zoom override</span>
            <span class="field">
              <span v-if="zoomOf(selectedTripleKey) === 0" class="none-hint">none</span>
              <input
                type="number"
                step="0.1"
                min="0"
                :value="zoomOf(selectedTripleKey)"
                @input="
                  (ev) =>
                    setZoom(selectedTripleKey!, Number((ev.target as HTMLInputElement).value))
                "
              />
              <span class="unit">×</span>
            </span>
          </label>

          <label class="row" title="Physical stereo baseline. Empty uses the app default. Sets Disparity Scope verge limits (next session) and calibration marker spacing (live).">
            <span class="label">Baseline</span>
            <span class="field">
              <span v-if="baselineOf(selectedTripleKey) === 0" class="none-hint"
                >app default: {{ effectiveBaselineFallback }} mm</span
              >
              <input
                type="number"
                step="1"
                min="0"
                :value="baselineOf(selectedTripleKey)"
                @input="
                  (ev) =>
                    setBaseline(
                      selectedTripleKey!,
                      Number((ev.target as HTMLInputElement).value),
                    )
                "
              />
              <span class="unit">mm</span>
            </span>
          </label>

          <label class="row" title="Trigger hold after the round-robin switches streams, before exposure. Applies at the next Multi-Fovea session; the drawer slider overrides live.">
            <span class="label">Settle time</span>
            <span class="field">
              <span v-if="settleMsOf(selectedTripleKey) === 0" class="none-hint"
                >none</span
              >
              <input
                type="number"
                step="0.1"
                min="0"
                max="20"
                :value="settleMsOf(selectedTripleKey)"
                @input="
                  (ev) =>
                    setSettleMs(
                      selectedTripleKey!,
                      Number((ev.target as HTMLInputElement).value),
                    )
                "
              />
              <span class="unit">ms</span>
            </span>
          </label>

          <label class="row" title="Positive predicts the target's position ahead to offset tracking-chain latency; negative retrodicts. Applies at the next Disparity Scope session.">
            <span class="label">Delay compensation</span>
            <span class="field">
              <!-- 0 is legible as "none" inline; the input stays anchored so
                   toggling never reflows the row. SIGNED (negative = lag). -->
              <span v-if="delayOf(selectedTripleKey) === 0" class="none-hint">none</span>
              <!-- SIGNED field: commit on @change (blur/Enter), NOT @input —
                   a live @input turns the intermediate "-" of "-5" into
                   Number("") === 0, clears the doc field, and Vue stamps "0"
                   back over the minus the user just typed. The unsigned siblings keep live @input. -->
              <input
                type="number"
                step="1"
                min="-50"
                max="50"
                :value="delayOf(selectedTripleKey)"
                @change="
                  (ev) =>
                    setDelay(selectedTripleKey!, Number((ev.target as HTMLInputElement).value))
                "
              />
              <span class="unit">ms</span>
            </span>
          </label>

          <!-- Device settings import / export / clear ---------------------- -->
          <div class="row device-actions">
            <span class="label">Device settings</span>
            <span class="field btn-group">
              <button class="btn" title="Export this rig's settings + records to a JSON file" @click="exportDevice">
                <Icon :icon="faFileExport" /> Export
              </button>
              <button class="btn" title="Import a device-config JSON file into this rig" @click="importDevice">
                <Icon :icon="faFileImport" /> Import
              </button>
              <button class="btn danger" title="Reset this rig's settings to defaults — calibration records are kept" @click="confirmClearDevice = true">
                Clear
              </button>
            </span>
          </div>

          <!-- Confirm device clear (in-place, layout-stable) --------------- -->
          <div v-if="confirmClearDevice" class="confirm-inline" role="alert">
            <span class="warn">Reset all settings for this rig to defaults? Calibration records are kept.</span>
            <span class="confirm-actions">
              <button class="btn danger" @click="doClearDevice">Reset</button>
              <button class="btn" @click="confirmClearDevice = false">Cancel</button>
            </span>
          </div>
        </template>
        <p v-else class="empty">
          No triples configured yet. Assign camera roles in Manage Cameras and
          calibrate a rig to create one.
        </p>

        <!-- ===== Calibration records (selected triple) ===================== -->
        <div v-if="selectedTripleKey" class="records">
          <h3 class="rec-head">
            Calibration records
            <span class="count" v-if="recordRows.length">({{ recordRows.length }})</span>
            <span class="head-actions">
              <!-- Always rendered (disabled+hinted below 2 selections) — a
                   v-if reflowed the header row AND hid the feature from anyone
                   who hadn't selected two rows yet. -->
              <button
                class="btn"
                :disabled="!selectedAllExtrinsic"
                :title="
                  selectedAllExtrinsic
                    ? 'Aggregate the selected records into a new record (sources are kept)'
                    : selectedCount >= 2
                      ? 'Only extrinsic records can be aggregated'
                      : 'Select 2+ extrinsic records to aggregate'
                "
                @click="aggregateSelected"
              >
                <Icon :icon="faLayerGroup" />
                Aggregate{{ selectedCount >= 2 ? ` ${selectedCount}` : "" }}
              </button>
              <button
                class="icon-button"
                title="Import a calibration record from a JSON file"
                @click="importRecordFile"
              >
                <Icon :icon="faFileImport" />
              </button>
            </span>
          </h3>

          <p v-if="recordRows.length === 0" class="empty small">
            No calibration records for this rig yet. Run <em>Extrinsic</em>
            calibration, or import a record with the button above.
          </p>

          <div v-for="row in recordRows" :key="row.id" class="rec-entry">
            <div class="rec-row">
              <input
                type="checkbox"
                class="rec-check"
                :checked="selectedIds.has(row.id)"
                :title="'Select for aggregation'"
                @change="toggleSelect(row.id)"
              />
              <span class="rec-main">
                <span class="rec-title">
                  <span class="rec-kind" :class="row.kind">{{ row.kind }}</span>
                  {{ row.count }}
                  {{
                    row.kind === "intrinsic"
                      ? row.count === 1
                        ? "view"
                        : "views"
                      : row.count === 1
                        ? "datapoint"
                        : "datapoints"
                  }}
                  <span v-if="row.role" class="rec-role">{{ row.role }}</span>
                  <span v-if="row.aggregated" class="rec-tag">aggregate</span>
                </span>
                <span class="rec-time">{{ row.localeTime }}</span>
              </span>
              <span class="rec-actions">
                <button
                  class="icon-button"
                  :class="{ active: overlayOn(tripleRecords.find((r) => r.id === row.id)!) }"
                  :disabled="row.kind !== 'extrinsic'"
                  :title="
                    row.kind === 'extrinsic'
                      ? 'Toggle live overlay on the calibration view'
                      : 'Overlay is available for extrinsic records only'
                  "
                  @click="toggleOverlay(tripleRecords.find((r) => r.id === row.id)!)"
                >
                  <Icon :icon="faEye" />
                </button>
                <button
                  class="icon-button"
                  :disabled="row.kind !== 'extrinsic'"
                  :title="
                    row.kind === 'extrinsic'
                      ? 'Inspect (observed vs projected)'
                      : 'The visualizer is available for extrinsic records only'
                  "
                  @click="inspectRecord(tripleRecords.find((r) => r.id === row.id)!)"
                >
                  <Icon :icon="faMagnifyingGlass" />
                </button>
                <button
                  class="icon-button"
                  title="Export this record to a JSON file"
                  @click="exportRecord(tripleRecords.find((r) => r.id === row.id)!)"
                >
                  <Icon :icon="faFileExport" />
                </button>
                <button
                  class="icon-button"
                  :class="{ arming: confirmDiscardId === row.id }"
                  title="Discard this record's association with this rig"
                  @click="confirmDiscardId = row.id"
                >
                  <Icon :icon="faTrash" />
                </button>
              </span>
            </div>
            <!-- The genuinely destructive zero-association case gets the danger
                 border back (nested normally mutes it) — the wording alone
                 didn't escalate visually. -->
            <div
              v-if="confirmDiscardId === row.id"
              class="confirm-inline nested"
              :class="{ orphan: wouldOrphan(tripleRecords.find((r) => r.id === row.id)!) }"
              role="alert"
            >
              <span class="warn">
                {{
                  wouldOrphan(tripleRecords.find((r) => r.id === row.id)!)
                    ? "Last association — the record file moves to the OS trash (recoverable)."
                    : "Removes this rig's association only; the record stays for its other rigs."
                }}
              </span>
              <span class="confirm-actions">
                <button class="btn danger" @click="doDiscardRecord(tripleRecords.find((r) => r.id === row.id)!)">
                  Discard
                </button>
                <button class="btn" @click="confirmDiscardId = null">Cancel</button>
              </span>
            </div>
          </div>
        </div>

        <!-- Full calibration-data inventory. Camera-bound intrinsic/extrinsic
             docs can't be reverse-mapped from a triple hash, so the WHOLE
             inventory stays reachable here (orphaned entries for disconnected
             rigs included); the per-triple fields above scope the editable
             overrides to the selected rig. -->
        <div class="inventory">
          <h3 class="inv-head">
            Calibration data
            <span class="count" v-if="entries.length">({{ entries.length }})</span>
            <button class="icon-button" title="Refresh calibration data" @click="refresh">
              <Icon :icon="faArrowsRotate" />
            </button>
          </h3>

          <p v-if="!loading && entries.length === 0" class="empty">
            No stored calibration data.
          </p>

          <div v-for="g in grouped" :key="g.category" class="group">
            <h3>{{ g.title }}</h3>
            <div v-for="e in g.items" :key="entryId(e)" class="entry">
              <div class="entry-head">
                <Icon
                  v-if="e.category === 'triples' && e.key === connectedKey"
                  :icon="faPlug"
                  class="conn-icon"
                  title="Connected rig"
                />
                <span v-else class="expander-spacer"></span>
                <span class="entry-label" :title="e.key">{{ e.label }}</span>
                <span class="entry-detail">{{ e.detail }}</span>
                <button
                  class="icon-button"
                  :class="{ arming: confirming === entryId(e) }"
                  title="Delete this calibration data"
                  @click="askDelete(e)"
                >
                  <Icon :icon="faTrash" />
                </button>
              </div>

              <!-- Two-step confirm as an in-place OVERLAY (absolute, anchored
                   under the row) so revealing it never reflows the rows below. -->
              <div v-if="confirming === entryId(e)" class="confirm-pop" role="alert">
                <p class="warn">
                  Deletes this data permanently. A running app keeps its loaded
                  copy until its next session.
                </p>
                <div class="confirm-actions">
                  <button class="btn danger" @click="doDelete(e)">Confirm delete</button>
                  <button class="btn" @click="cancelDelete">Cancel</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- Triple picker modal (same DOM, centered floating scrollable list —
         reuses the app's .modal-scrim/.modal shell). Opening it does not shift
         the underlying layout (fixed scrim); no fade/slide. -->
    <div
      v-if="tripleDialogOpen"
      class="modal-scrim"
      @click.self="tripleDialogOpen = false"
    >
      <div class="modal triple-dialog" role="dialog" aria-label="Select a triple">
        <h3>Select a triple</h3>
        <ul class="triple-list">
          <li v-for="t in orderedTriples" :key="t.key">
            <button
              class="triple-item"
              :class="{ active: t.key === selectedTripleKey }"
              @click="selectTriple(t.key)"
            >
              <Icon
                v-if="t.connected"
                :icon="faPlug"
                class="conn-icon"
                title="Connected rig"
              />
              <span v-else class="conn-spacer"></span>
              <span class="ti-label" :title="t.key">
                {{ nicknames[t.key] || t.label }}
                <span v-if="nicknames[t.key]" class="ti-sub">{{ t.label }}</span>
              </span>
              <span class="ti-detail">{{ t.detail }}</span>
            </button>
          </li>
        </ul>
        <div class="modal-actions">
          <button @click="tripleDialogOpen = false">Close</button>
        </div>
      </div>
    </div>

    <!-- Inspect: the observed-vs-projected visualizer (virtual stream). -->
    <div v-if="inspecting" class="modal-scrim" @click.self="inspecting = null">
      <div class="modal viz-dialog" role="dialog" aria-label="Calibration record inspector">
        <h3>
          Calibration record
          <button
            class="btn overlay-toggle"
            :class="{ active: overlayOn(inspecting) }"
            title="Toggle this record as a live overlay on the calibration view"
            @click="toggleOverlay(inspecting)"
          >
            <Icon :icon="faEye" /> {{ overlayOn(inspecting) ? "Overlay on" : "Overlay off" }}
          </button>
        </h3>
        <div class="viz-body">
          <CalibrationVisualizer v-if="inspectDataset" :dataset="inspectDataset" />
        </div>
        <div class="modal-actions">
          <button @click="inspecting = null">Close</button>
        </div>
      </div>
    </div>

    <!-- Cross-triple device import → prompt for a new nickname. -->
    <div
      v-if="pendingDeviceImport"
      class="modal-scrim"
      @click.self="pendingDeviceImport = null"
    >
      <div class="modal prompt-dialog" role="dialog" aria-label="Name the imported rig">
        <h3>Name this rig</h3>
        <p class="hint">Imported from a different rig — name it for the selected one.</p>
        <!-- Enter-to-confirm implies typing-first: focus on mount. -->
        <input
          v-model="pendingDeviceImport.nickname"
          type="text"
          placeholder="Rig nickname"
          autofocus
          @vue:mounted="({ el }: any) => (el as HTMLInputElement).focus()"
          @keyup.enter="confirmDeviceImport"
        />
        <div class="modal-actions">
          <button @click="pendingDeviceImport = null">Cancel</button>
          <button class="primary" @click="confirmDeviceImport">Import</button>
        </div>
      </div>
    </div>

    <!-- Transient status toast (import/export outcomes). -->
    <div v-if="message" class="toast" role="status">{{ message }}</div>
  </div>
</template>

<style scoped lang="scss">
// Fixed tab header + independently-scrolling content: the header never leaves
// the viewport (flex-shrink:0), only `.tab-content` scrolls.
.config-root {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.tabs {
  flex-shrink: 0;
  display: flex;
  gap: 0.4ch;
  padding: 0.6rem 1.5rem 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg-app);
}

.tab {
  font-family: inherit;
  font-size: var(--fs-md);
  color: var(--text-muted);
  background: none;
  border: none;
  // 2px bottom border always present (transparent) so selecting only recolors
  // it — no layout shift; the switch snaps (no transition).
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: 0.5em 1em;
  cursor: pointer;
  outline: none;
  &:hover {
    color: var(--text);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  &.active {
    color: var(--text);
    border-bottom-color: var(--accent-bright);
  }
}

.tab-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 1.5rem 3rem;
}

section {
  margin-bottom: 2rem;

  h2 {
    display: flex;
    align-items: center;
    gap: 0.6ch;
    font-size: var(--fs-lg);
    color: var(--text-dim);
    font-weight: 600;
    margin: 0 0 1rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--border);

    .count {
      color: var(--text-faint);
      font-size: 0.7em;
      font-weight: 400;
    }
    .icon-button {
      margin-left: auto;
    }
  }
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1ch;
  padding: 0.3rem 0;
  min-height: 2.2em; // layout-stable

  .label {
    color: var(--text-muted);
  }

  input[type="text"] {
    flex: 1;
    min-width: 20ch;
    max-width: 42ch;
  }
}

.field {
  display: flex;
  align-items: center;
  gap: 0.5ch;
  .unit {
    color: var(--text-faint);
    min-width: 2ch;
  }
  input[type="number"] {
    width: 9ch;
    text-align: right;
  }
}

input {
  font-family: inherit;
  font-size: 1em;
  color: var(--text);
  background-color: var(--bg-chrome);
  border: none;
  border-bottom: 2px solid var(--border-muted);
  outline: none;
  padding: 0.3em 0.5em;
  &:hover {
    border-bottom-color: var(--text-muted);
  }
  &:focus {
    border-bottom-color: var(--accent-bright);
  }
  &.invalid {
    border-bottom-color: var(--danger);
  }
}

.hint {
  color: var(--text-faint);
  font-size: var(--fs-sm);
  margin: 0 0 0.6rem;
  &.err {
    color: var(--danger-text);
  }
}

// Label-above-content row (for controls too wide for the inline `.row`).
.stacked-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.3rem 0;

  .label {
    color: var(--text-muted);
  }
}

.anaglyph-cards {
  display: flex;
  flex-wrap: wrap; // wrap on narrow
  gap: 0.6rem;
}

.anaglyph-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem;
  background: var(--bg-chrome);
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-muted);
  font-family: inherit;
  // 2px border always present (transparent) so selecting only recolors it —
  // no layout shift (design-language: layout-stable, instant cue). No
  // transition: control-path feedback snaps, and the
  // selected state never relies on animation (prefers-reduced-motion safe).
  border: 2px solid transparent;
  outline: none;

  &:hover {
    border-color: var(--border-muted);
    color: var(--text);
  }
  // Focus ring is DISTINCT from selection: an offset outline (the app's focus
  // convention) rather than the selection border, so a keyboard-focused card
  // reads apart from the accent-bordered selected one.
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  &.selected {
    border-color: var(--accent-bright);
    color: var(--text);
  }
}

.swatch {
  display: flex;
  width: 72px;
  height: 46px;
  border-radius: 4px;
  overflow: hidden;

  .half {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    // White glyph on every half — a surrounding dark halo (not just a drop
    // shadow) keeps it legible on the lighter halves too (resolved cyan/green
    // sit ~0.4 luminance, where flat white alone is marginal). Per-half text
    // treatment only; the swatch color itself is never tinted (stays truthful).
    color: #fff;
    font-weight: 700;
    font-size: var(--fs-sm);
    text-shadow:
      0 0 3px rgba(0, 0, 0, 0.7),
      0 1px 2px rgba(0, 0, 0, 0.6);
  }
}

.card-name {
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.03em;
}

select {
  font-family: inherit;
  font-size: 1em;
  color: var(--text);
  background-color: var(--bg-chrome);
  border: none;
  border-bottom: 2px solid var(--border-muted);
  outline: none;
  padding: 0.3em 0.5em;
  cursor: pointer;
  &:hover {
    border-bottom-color: var(--text-muted);
  }
  &:focus {
    border-bottom-color: var(--accent-bright);
  }
}

.tele-urls {
  list-style: none;
  margin: 0 0 0.6rem;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;

  li {
    display: flex;
    align-items: center;
    gap: 1ch;
    padding: 0.35em 0.6em;
    border: 1px solid var(--border);
    border-radius: 4px;
    background-color: var(--bg-panel-alt);
  }
  .u-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
    user-select: text;
  }
}

.empty {
  color: var(--text-faint);
  padding: 1rem 0;
}

.group {
  margin-bottom: 1rem;
  h3 {
    font-size: 1em;
    color: var(--text-faint);
    font-weight: 600;
    margin: 0.5rem 0;
  }
}

.entry {
  position: relative; // anchor for the in-place delete-confirm overlay
  border: 1px solid var(--border);
  border-radius: 4px;
  margin-bottom: 0.4rem;
  background-color: var(--bg-panel-alt);
}

.entry-head {
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 0.5em 0.7em;

  .entry-label {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 8ch;
  }
  .entry-detail {
    color: var(--text-faint);
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
}

.expander-spacer {
  width: 1.6em;
  flex-shrink: 0;
}

// Inline "none" hint shared by the per-triple number fields (Device tab).
.none-hint {
  font-size: var(--fs-sm);
  color: var(--text-muted);
  white-space: nowrap;
}

// ---- Device-config triple selector -----------------------------------------
.selector-row {
  min-height: 2.4em;
}

.triple-select {
  display: flex;
  align-items: center;
  gap: 0.8ch;
  flex: 1;
  min-width: 24ch;
  max-width: 42ch;
  font-family: inherit;
  font-size: 1em;
  color: var(--text);
  background: var(--bg-chrome);
  border: none;
  border-bottom: 2px solid var(--border-muted);
  outline: none;
  padding: 0.35em 0.6em;
  cursor: pointer;
  text-align: left;
  &:hover:not(:disabled) {
    border-bottom-color: var(--text-muted);
  }
  &:focus-visible {
    border-bottom-color: var(--accent-bright);
  }
  &:disabled {
    color: var(--text-faint);
    cursor: default;
  }
  .sel-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .caret {
    color: var(--text-faint);
    flex-shrink: 0;
  }
}

.conn-icon {
  color: var(--accent-bright);
  flex-shrink: 0;
}
.inline-icon {
  color: var(--accent-bright);
}
.conn-spacer {
  width: 1em;
  flex-shrink: 0;
}
.disc-chip {
  font-size: var(--fs-sm);
  color: var(--text-faint);
  white-space: nowrap;
  padding: 0.05em 0.5em;
  border: 1px solid var(--border-muted);
  border-radius: 999px;
  flex-shrink: 0;
}

// ---- Calibration-data inventory (Device tab, below the per-triple fields) ---
.inventory {
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}
.inv-head {
  display: flex;
  align-items: center;
  gap: 0.6ch;
  font-size: var(--fs-md);
  color: var(--text-dim);
  font-weight: 600;
  margin: 0 0 0.8rem;
  .count {
    color: var(--text-faint);
    font-size: 0.8em;
    font-weight: 400;
  }
  .icon-button {
    margin-left: auto;
  }
}

// ---- Triple picker modal (reuses the app .modal-scrim / .modal shell) -------
.modal-scrim {
  position: fixed;
  inset: 0;
  background: #000a;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.triple-dialog {
  background: var(--bg-panel-alt);
  border: 1px solid var(--tint-3);
  border-radius: 8px;
  padding: 1.2em 1.3em;
  width: min(52ch, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  color: var(--text-strong);
  box-shadow: 0 8px 30px var(--shadow);
  h3 {
    margin: 0 0 0.8em;
    color: var(--text);
  }
}
.triple-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto; // the list scrolls; the dialog shell stays put
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.triple-item {
  display: flex;
  align-items: center;
  gap: 1ch;
  width: 100%;
  font-family: inherit;
  font-size: 1em;
  color: var(--text);
  background: var(--bg-panel-alt);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.5em 0.7em;
  cursor: pointer;
  text-align: left;
  outline: none;
  &:hover {
    background: var(--tint-1);
    border-color: var(--border-muted);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  &.active {
    border-color: var(--accent-bright);
  }
  .ti-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ti-detail {
    color: var(--text-faint);
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 1ch;
  margin-top: 1em;
  button {
    background: var(--bg-app);
    color: var(--text-strong);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 0.35em 1.1em;
    cursor: pointer;
    &:hover {
      background: var(--bg-elevated);
    }
  }
}

// In-place confirm overlay: floats over the rows below (never reflows them).
.confirm-pop {
  position: absolute;
  top: calc(100% - 1px);
  right: -1px;
  left: -1px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 0.5em;
  padding: 0.6em 0.8em;
  border: 1px solid var(--danger);
  border-radius: 0 0 4px 4px;
  background-color: var(--bg-elevated);
  box-shadow: 0 4px 10px var(--shadow);
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6ch;
}

.warn {
  color: var(--danger-text);
  font-size: var(--fs-sm);
  margin: 0;
}

.btn {
  font-family: inherit;
  font-size: 0.85em;
  padding: 0.3em 0.8em;
  border-radius: 4px;
  border: 1px solid var(--border-muted);
  background: var(--bg-elevated);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  &:hover {
    background: var(--tint-2);
  }
  &.danger {
    border-color: var(--danger);
    color: var(--danger-text);
    &:hover {
      background: var(--danger-bg);
    }
  }
}

.icon-button {
  background: none;
  border: none;
  padding: 0.4em;
  margin: 0;
  cursor: pointer;
  color: inherit;
  border-radius: 4px;
  outline: 1px solid transparent;
  &:not(:disabled):hover {
    background: var(--tint-1);
    outline: 1px solid var(--border-muted);
  }
  &.arming {
    color: var(--danger-text);
  }
  &.active {
    color: var(--accent-bright);
  }
}

// ---- Nickname + device-config actions --------------------------------------
.nickname-input {
  flex: 1;
  min-width: 20ch;
  max-width: 42ch;
}
.device-actions {
  margin-top: 0.6rem;
}
.btn-group {
  display: flex;
  gap: 0.5ch;
  flex-wrap: wrap;
}
.btn {
  // (Base `.btn` already defined above.) Icon spacing inside a button.
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
}
.confirm-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1ch;
  flex-wrap: wrap;
  padding: 0.5em 0.7em;
  margin: 0 0 0.6rem;
  border: 1px solid var(--danger);
  border-radius: 4px;
  background: var(--bg-elevated);
  &.nested {
    margin: 0.2rem 0 0;
    border-color: var(--border-muted);
    // Zero-association discard = the file leaves the store (OS trash) — keep
    // the danger chrome for that case only.
    &.orphan {
      border-color: var(--danger);
    }
  }
}

// ---- Calibration records list ----------------------------------------------
.records {
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}
.rec-head {
  display: flex;
  align-items: center;
  gap: 0.6ch;
  font-size: var(--fs-md);
  color: var(--text-dim);
  font-weight: 600;
  margin: 0 0 0.8rem;
  .count {
    color: var(--text-faint);
    font-size: 0.8em;
    font-weight: 400;
  }
  .head-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.5ch;
  }
}
.empty.small {
  padding: 0.6rem 0;
  font-size: var(--fs-sm);
}
.rec-entry {
  border: 1px solid var(--border);
  border-radius: 4px;
  margin-bottom: 0.4rem;
  background-color: var(--bg-panel-alt);
  padding: 0.2rem 0.3rem;
}
.rec-row {
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 0.35em 0.4em;
}
.rec-check {
  flex-shrink: 0;
  cursor: pointer;
}
.rec-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1em;
}
.rec-title {
  display: flex;
  align-items: center;
  gap: 0.8ch;
  color: var(--text);
  .rec-role {
    font-weight: 700;
    color: var(--accent-bright);
  }
  .rec-tag {
    font-size: var(--fs-sm);
    color: var(--text-faint);
    border: 1px solid var(--border-muted);
    border-radius: 999px;
    padding: 0 0.6ch;
  }
  // Kind badge — reads which calibration a record holds at a glance. Extrinsic
  // is the common case (muted); intrinsic is accented so it stands apart.
  .rec-kind {
    font-size: var(--fs-sm);
    letter-spacing: 0.02em;
    border-radius: 999px;
    padding: 0 0.6ch;
    border: 1px solid var(--border-muted);
    color: var(--text-faint);
    &.intrinsic {
      color: var(--accent-bright);
      border-color: var(--accent-bright);
    }
  }
}
.rec-time {
  color: var(--text-faint);
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
}
.rec-actions {
  display: flex;
  align-items: center;
  gap: 0.2ch;
  flex-shrink: 0;
}

// ---- Inspector / prompt modals + toast -------------------------------------
.viz-dialog {
  background: var(--bg-panel-alt);
  border: 1px solid var(--tint-3);
  border-radius: 8px;
  padding: 1.2em 1.3em;
  width: min(80ch, 92vw);
  height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  color: var(--text-strong);
  box-shadow: 0 8px 30px var(--shadow);
  h3 {
    display: flex;
    align-items: center;
    gap: 1ch;
    margin: 0 0 0.8em;
    color: var(--text);
  }
  .overlay-toggle {
    margin-left: auto;
    &.active {
      border-color: var(--accent-bright);
      color: var(--accent-bright);
    }
  }
}
.viz-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.prompt-dialog {
  background: var(--bg-panel-alt);
  border: 1px solid var(--tint-3);
  border-radius: 8px;
  padding: 1.2em 1.3em;
  width: min(48ch, 90vw);
  display: flex;
  flex-direction: column;
  gap: 0.6em;
  color: var(--text-strong);
  box-shadow: 0 8px 30px var(--shadow);
  h3 {
    margin: 0;
    color: var(--text);
  }
  input {
    max-width: none;
  }
  .modal-actions .primary {
    border-color: var(--accent-bright);
    color: var(--accent-bright);
  }
}
.ti-sub {
  display: block;
  font-size: var(--fs-sm);
  color: var(--text-faint);
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 1.5rem;
  transform: translateX(-50%);
  z-index: 200;
  padding: 0.5em 1em;
  border-radius: 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  color: var(--text-strong);
  box-shadow: 0 4px 16px var(--shadow);
  font-size: var(--fs-sm);
}
</style>
