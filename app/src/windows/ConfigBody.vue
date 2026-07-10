<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Settings window body (async; mounted under ConfigWindow's <Suspense>). A fixed
  tab header (never scrolls out of view — only the tab content scrolls) switches
  between two tabs:
    1. GLOBAL config — app-wide config bound to the shared `["config"]` document
       through `useConfigRef`, so an edit here applies LIVE across windows (the
       store-hub broadcasts to every open window's `Store` client). Marker
       size/ratio + the TeleCanvas URL apply live to a running calibrate-* /
       RemoteCanvas; the default save dir applies next session (hint says).
    2. DEVICE config (per-triple) — everything scoped to ONE selected triple:
       the per-triple overrides (baseline, zoom, settle, delay compensation)
       PLUS the full calibration-data inventory (intrinsic / extrinsic / every
       triple doc) so orphaned entries for disconnected rigs stay reachable. A
       selector (first item) switches triples via a centered modal list; the
       CONNECTED rig is selected by default and badged with a plug icon.
       Friendly names resolve against the currently-known cameras (probe list).
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import Store from "@lib/store";
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
import type { ProbeCamera } from "@lib/orchestrator/probe";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faArrowsRotate, faChevronDown } from "./icons";
import { faTrash, faCopy, faCheck, faPlug } from "@fortawesome/free-solid-svg-icons";

// ---- Tabs (fixed header; only the content below scrolls) -------------------
type Tab = "global" | "device";
const activeTab = ref<Tab>("global");
// One shared scroller hosts both v-show sections (preserves expanded/transient
// state across switches) — reset it on tab change so Device doesn't open
// pre-scrolled to Global's offset (UI/UX review 2026-07-10).
const tabContent = ref<HTMLElement | null>(null);
watch(activeTab, () => tabContent.value?.scrollTo({ top: 0 }));

// ---- App-level config (live, writable refs over the shared document) --------
const default_save_dir = await useConfigRef("default_save_dir");
const record_compression = await useConfigRef("record_compression");
const tele_canvas_mode = await useConfigRef("tele_canvas_mode");
const tele_canvas_url = await useConfigRef("tele_canvas_url");
const tele_canvas_port = await useConfigRef("tele_canvas_port");
// LEGACY app-level baseline — no longer an App-section field (Ruling A moved
// the baseline to a per-TRIPLE setting). Kept here only to show the effective
// FALLBACK value in a triple's baseline hint when that triple has no override.
const baseline_distance_mm = await useConfigRef("baseline_distance_mm");
const cal_marker_size_mm = await useConfigRef("cal_marker_size_mm");
const cal_marker_ratio = await useConfigRef("cal_marker_ratio");
// Anaglyph style (user ruling 2026-07-09): live-writable ref over the shared
// config doc. The card view-models (label + literal swatch colors + selection)
// come from the SHARED `docs/schema/anaglyph` helper so the cards render the
// exact same truth the viewer/native brick compose. Clicking a card writes the
// style — applies live (disparity-scope center Anaglyph view + viewer 3D).
const anaglyph_style = await useConfigRef("anaglyph_style");
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
// Open the selected triple's reactive doc so the per-triple fields bind to it.
watch(
  selectedTripleKey,
  (key) => {
    if (key) void openTripleDoc(key);
  },
  { immediate: true },
);

function selectTriple(key: string) {
  selectedTripleKey.value = key;
  tripleDialogOpen.value = false; // instant close (no fade) — snap ruling
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
         Tab switch is instant (no fade/slide) per the snap ruling. -->
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

      <label class="row">
        <span class="label">Default save directory</span>
        <input
          type="text"
          :class="{ invalid: !saveDirValid }"
          v-model="default_save_dir"
          placeholder="auto (external drive or ~/Downloads)"
          @input="checkSaveDir"
        />
      </label>
      <p class="hint">
        Base folder for captures &amp; recordings. Leave empty for auto. Applies
        to save/record destinations opened after the change.
      </p>

      <label class="row">
        <span class="label">Recording compression</span>
        <span class="field">
          <select v-model="record_compression">
            <option value="none">None (raw)</option>
            <option value="zlib">zlib (lossless)</option>
          </select>
        </span>
      </label>
      <p class="hint">
        Applies to recordings started after the change; running recordings keep
        their method. zlib is lossless and decodes in the viewer like raw
        recordings. Note: lossless zlib may not hold full-rate 12-bit on all
        three cameras — drops are attributed in the record button's hover.
      </p>

      <label class="row">
        <span class="label">TeleCanvas mode</span>
        <span class="field">
          <select v-model="tele_canvas_mode">
            <option value="client">Client (push to remote)</option>
            <option value="host">Host (serve locally)</option>
          </select>
        </span>
      </label>

      <label v-if="!teleIsHost" class="row">
        <span class="label">TeleCanvas server URL</span>
        <input
          type="text"
          :class="{ invalid: teleUrlInvalid }"
          v-model="tele_canvas_url"
          placeholder="empty = disabled"
        />
      </label>
      <p v-if="!teleIsHost" class="hint">
        The app's windows PUT their projection here. Empty = disabled. Applies live.
      </p>

      <label v-else class="row">
        <span class="label">TeleCanvas server port</span>
        <span class="field">
          <input type="number" step="1" min="1" max="65535" v-model.number="tele_canvas_port" />
        </span>
      </label>
      <p v-if="teleIsHost" class="hint">
        The app serves its own TeleCanvas viewer. Open a URL below on a TV or
        tablet on the same network. Applies live.
      </p>
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

      <label class="row">
        <span class="label">Calibration marker size</span>
        <span class="field">
          <input type="number" step="1" min="1" v-model.number="cal_marker_size_mm" />
          <span class="unit">mm</span>
        </span>
      </label>
      <p class="hint">Applies live to open Extrinsic / Drift calibration windows.</p>

      <label class="row">
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
      <p class="hint">Inner/outer marker ratio. Applies live.</p>

      <div class="stacked-row">
        <span class="label">Anaglyph style</span>
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
      <p class="hint">
        Left-eye / right-eye colors for the anaglyph 3D view (R = red, B = blue,
        C = cyan). Applies live to Disparity Scope's center Anaglyph view and the
        recording viewer's 3D mode.
      </p>
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
            :title="orderedTriples.length === 0 ? 'No triples configured' : 'Choose a triple'"
            @click="tripleDialogOpen = true"
          >
            <Icon
              v-if="selectedTriple?.connected"
              :icon="faPlug"
              class="conn-icon"
              title="Connected rig"
            />
            <span class="sel-label">{{
              selectedTriple ? selectedTriple.label : "No triples configured"
            }}</span>
            <span v-if="selectedTriple && !selectedTriple.connected" class="disc-chip"
              >not connected</span
            >
            <Icon :icon="faChevronDown" class="caret" />
          </button>
        </div>
        <p class="hint">
          Pick the rig (L / C / R triple) to configure. The connected rig
          <Icon :icon="faPlug" class="inline-icon" /> is selected by default; you
          can also edit a rig that isn't plugged in — its changes save to its own
          stored config.
        </p>

        <!-- Per-triple overrides for the SELECTED triple ------------------- -->
        <template v-if="selectedTripleKey">
          <label class="row">
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
          <p class="hint">
            0 = none (use the calibration-measured magnification). Drives
            Disparity Scope's Auto match zoom on the next session start; the
            window's own zoom knob still overrides when set.
          </p>

          <label class="row">
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
          <p class="hint">
            Physical stereo baseline for this triple. Empty = use the app
            default. Applies to Disparity Scope's verge limits and the Extrinsic
            / Drift / Distortion marker spacing (marker spacing updates live; the
            verge limit applies on the next session start).
          </p>

          <label class="row">
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
          <p class="hint">
            0 = no hold. Multi-Fovea holds the trigger this long after the
            round-robin SWITCHES streams (mirror moved), then runs the normal
            exposure — independent of exposure time. Applies on the next
            Multi-Fovea session start; the app's drawer slider overrides it live
            for a running session.
          </p>

          <label class="row">
            <span class="label">Delay compensation</span>
            <span class="field">
              <!-- 0 is legible as "none" inline; the input stays anchored so
                   toggling never reflows the row. SIGNED (negative = lag). -->
              <span v-if="delayOf(selectedTripleKey) === 0" class="none-hint">none</span>
              <!-- SIGNED field: commit on @change (blur/Enter), NOT @input —
                   a live @input turns the intermediate "-" of "-5" into
                   Number("") === 0, clears the doc field, and Vue stamps "0"
                   back over the minus the user just typed (UI/UX review
                   2026-07-10). The unsigned siblings keep live @input. -->
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
          <p class="hint">
            0 = off (tracker output used as-is). Disparity Scope chains an IMM
            motion predictor after the tracker so the mirrors act on the target's
            ESTIMATED position at t + this delay: POSITIVE leads (predicts ahead,
            to offset tracking-chain latency), negative lags (retrodicts).
            Applies on the next Disparity Scope session start.
          </p>
        </template>
        <p v-else class="empty">
          No triples configured yet. Assign camera roles in Manage Cameras and
          calibrate a rig to create one.
        </p>

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
                  Deletes stored data permanently. If an app is running it keeps
                  the copy it loaded at activation; the deletion takes effect on
                  the next session.
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
         the underlying layout (fixed scrim); no fade/slide (snap ruling). -->
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
              <span class="ti-label" :title="t.key">{{ t.label }}</span>
              <span class="ti-detail">{{ t.detail }}</span>
            </button>
          </li>
        </ul>
        <div class="modal-actions">
          <button @click="tripleDialogOpen = false">Close</button>
        </div>
      </div>
    </div>
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
  // it — no layout shift; the switch snaps (no transition, instant ruling).
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
  // transition: control-path feedback snaps (instant/snap ruling), and the
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
}
</style>
