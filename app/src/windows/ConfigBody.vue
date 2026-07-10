<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Settings window body (async; mounted under ConfigWindow's <Suspense>). Two
  sections:
    1. Application — app-level config bound to the shared `["config"]` document
       through `useConfigRef`, so an edit here applies LIVE across windows (the
       store-hub broadcasts to every open window's `Store` client). Marker
       size/ratio + the TeleCanvas URL apply live to a running calibrate-* /
       RemoteCanvas; the default save dir applies next session (hint says). The
       baseline is NO LONGER here — Ruling A moved it to a per-TRIPLE setting.
    2. Calibration data — enumerate every stored intrinsic / extrinsic / triple
       document (`@lib/calibration-data`), inspect metadata, edit a triple's
       `zoom_override` + `baseline_mm`, and DELETE entries (two-step confirm).
       Friendly names resolve against the currently-known cameras (Welcome
       probe list).
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
  type CalStore,
  type CalEntry,
  type CalCategory,
  type KnownCamera,
  type TripleConfig,
} from "@lib/calibration-data";
import type { ProbeCamera } from "@lib/orchestrator/probe";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faArrowsRotate, faChevronDown, faChevronUp } from "./icons";
import { faTrash, faCopy, faCheck } from "@fortawesome/free-solid-svg-icons";

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

async function refresh() {
  loading.value = true;
  try {
    entries.value = await enumerateCalibrationData(calStore, cameras.value);
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

// ---- Per-triple zoom_override editing (expandable) -------------------------
const expanded = ref<Set<string>>(new Set());
// Reactive triple docs, opened lazily on first expand. `Store.open` returns a
// reactive object; mutating `zoom_override` re-persists the WHOLE document, so
// drift_l/drift_r (and any other field) are preserved.
const tripleDocs = ref<Record<string, TripleConfig>>({});

async function toggleExpand(e: CalEntry) {
  const id = entryId(e);
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else {
    next.add(id);
    if (e.category === "triples" && !(e.key in tripleDocs.value))
      tripleDocs.value[e.key] = await Store.open<TripleConfig>(["triples", e.key]);
  }
  expanded.value = next;
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
  expanded.value.delete(entryId(e));
  delete tripleDocs.value[e.key];
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
  <div class="scroll">
    <!-- ============ Application ============ -->
    <section>
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

    <!-- ============ Calibration data ============ -->
    <section>
      <h2>
        Calibration data
        <span class="count" v-if="entries.length">({{ entries.length }})</span>
        <button class="icon-button" title="Refresh calibration data" @click="refresh">
          <Icon :icon="faArrowsRotate" />
        </button>
      </h2>

      <p v-if="!loading && entries.length === 0" class="empty">
        No stored calibration data.
      </p>

      <div v-for="g in grouped" :key="g.category" class="group">
        <h3>{{ g.title }}</h3>
        <div v-for="e in g.items" :key="entryId(e)" class="entry">
          <div class="entry-head">
            <button
              v-if="e.category === 'triples'"
              class="expander"
              :title="expanded.has(entryId(e)) ? 'Collapse' : 'Expand'"
              @click="toggleExpand(e)"
            >
              <Icon :icon="expanded.has(entryId(e)) ? faChevronUp : faChevronDown" />
            </button>
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

          <!-- Two-step confirm as an in-place OVERLAY (absolute, anchored under
               the row) so revealing it never reflows the entries below it. -->
          <div v-if="confirming === entryId(e)" class="confirm-pop" role="alert">
            <p class="warn">
              Deletes stored data permanently. If an app is running it keeps the
              copy it loaded at activation; the deletion takes effect on the next
              session.
            </p>
            <div class="confirm-actions">
              <button class="btn danger" @click="doDelete(e)">Confirm delete</button>
              <button class="btn" @click="cancelDelete">Cancel</button>
            </div>
          </div>

          <div
            v-if="e.category === 'triples' && expanded.has(entryId(e))"
            class="triple-body"
          >
            <label class="row">
              <span class="label">Zoom override</span>
              <span class="field">
                <!-- Mirrors disparity-scope's zoom "Auto" hint: 0 is legible as
                     "none" inline; the input stays anchored so toggling never
                     reflows the row. -->
                <span v-if="zoomOf(e.key) === 0" class="none-hint">none</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  :value="zoomOf(e.key)"
                  @input="
                    (ev) => setZoom(e.key, Number((ev.target as HTMLInputElement).value))
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
                <!-- Empty (0) shows the effective app-default fallback inline;
                     the input stays anchored so toggling never reflows. -->
                <span v-if="baselineOf(e.key) === 0" class="none-hint"
                  >app default: {{ effectiveBaselineFallback }} mm</span
                >
                <input
                  type="number"
                  step="1"
                  min="0"
                  :value="baselineOf(e.key)"
                  @input="
                    (ev) => setBaseline(e.key, Number((ev.target as HTMLInputElement).value))
                  "
                />
                <span class="unit">mm</span>
              </span>
            </label>
            <p class="hint">
              Physical stereo baseline for this triple. Empty = use the app
              default. Applies to Disparity Scope's verge limits and the
              Extrinsic / Drift / Distortion marker spacing (marker spacing
              updates live; the verge limit applies on the next session start).
            </p>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.scroll {
  height: 100%;
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

.expander,
.expander-spacer {
  width: 1.6em;
  flex-shrink: 0;
}
.expander {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.2em;
  &:hover {
    color: var(--text);
  }
}

.triple-body {
  padding: 0.2em 0.9em 0.6em;
  border-top: 1px solid var(--border);

  .none-hint {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    white-space: nowrap;
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
