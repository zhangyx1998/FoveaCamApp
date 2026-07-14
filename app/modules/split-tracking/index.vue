<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Split Tracking — a thin client over the `split-tracking` session. Two
  INDEPENDENT single-eye visual servos: drop a target on the LEFT fovea and one
  on the RIGHT, each mirror steers to keep its target frame-centered. The center
  wide view is context-only. Views are capturable/recordable (title-bar buttons).
  Behavior spec: docs/proposals/split-tracking-app.md.

  Renderer-zero-core: every `core` import here is TYPE-ONLY (erased at build).
-->
<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ROLE, THEME } from "@lib/camera-config";
import { useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { Point2d } from "core/Geometry";
import Capture from "@src/capture";
import Recording from "@src/record";
import StreamView from "@src/components/StreamView.vue";
import PosView, { type Pos } from "@src/components/PosView.vue";
import Drawer from "@src/components/Drawer.vue";
import SingleSelect, { type SingleSelectOption } from "@src/inputs/single-select.vue";
import { splitTracking, type Eye, type PidGains } from "./contract";
import { MIN_TILE, MAX_TILE } from "./tracking";

const session = useSession(splitTracking, "split-tracking");
const { state, telemetry } = session;

// Title-bar camera-Capture toggle + RecordButton (shared facades register
// themselves via their module singletons — constructing is enough).
const capture = new Capture(session, "split-tracking");
new Recording(session, "split-tracking");

// Per-eye fovea pipes: L/R ride the ADVERTISED undistort pipe (a pipe-id
// string in state.undistort) with a convert fallback; C is context (convert).
const frameL = usePipeFrame(() =>
  state.serials?.L ? (state.undistort.L ?? nodeId.convert(state.serials.L)) : null,
);
const frameR = usePipeFrame(() =>
  state.serials?.R ? (state.undistort.R ?? nodeId.convert(state.serials.R)) : null,
);
const frameC = usePipeFrame(() =>
  state.serials?.C ? nodeId.convert(state.serials.C) : null,
);

// --- per-eye target selector + drag lifecycle -------------------------------
// PosView emits a Pos stream while dragging (mousedown → moves → null on
// release). The two sides are fully independent. `drag[eye]` holds the live
// CENTER-RELATIVE position (non-null exactly while that side is being dragged),
// which doubles as our drag-in-progress flag.
const drag = reactive<Record<Eye, Pos | null>>({ L: null, R: null });

/** Half-frame vector; PosView `@select` is center-relative, image px = p + this. */
function centerVec(eye: Eye): Point2d {
  const s = telemetry.size[eye];
  return { x: s.width / 2, y: s.height / 2 };
}

// Drag START = the FIRST non-null emit (drag[eye] was null) → pause that side's
// tracker + hold its mirror. Drag END = the null emit → (re)arm the tracker at
// the LAST non-null position (image px) + resume the servo. Independent per eye.
function onSelect(eye: Eye, p: Pos | null): void {
  if (p) {
    if (drag[eye] === null) void session.call("pauseTracker", { eye });
    drag[eye] = p;
  } else {
    const last = drag[eye];
    drag[eye] = null;
    if (last) {
      const c = centerVec(eye);
      void session.call("armTarget", {
        eye,
        center: { x: last.x + c.x, y: last.y + c.y },
      });
    }
  }
}

// --- per-eye view model (annotations in IMAGE-PIXEL space) ------------------
// The tile box / crosshair / bbox draw in the StreamView default slot, whose
// SVG viewBox is `0 0 width height` (pixel-accurate on the displayed frame).
// The PosView selector uses `:lim` = half the frame (width/2 == height/2 for a
// square fovea crop), so its center-relative Pos maps 1:1 to image px.
function viewModel(eye: Eye) {
  const size = telemetry.size[eye];
  const c = centerVec(eye);
  const t = telemetry.tracked[eye];
  const d = drag[eye];
  // Annotation center (image px): the drag marker while dragging, else the live
  // tracked center, else the frame center.
  const annCenter: Point2d = d
    ? { x: d.x + c.x, y: d.y + c.y }
    : (t?.center ?? c);
  // PosView marker (center-relative): follows the drag, else the tracked center.
  const marker: Pos = d
    ? d
    : t?.center
      ? { x: t.center.x - c.x, y: t.center.y - c.y }
      : { x: 0, y: 0 };
  const { w, h } = state.tile;
  return {
    size,
    center: c,
    marker,
    lim: Math.max(size.width / 2, 1),
    stroke: Math.max(size.width, size.height, 1) * 0.003,
    tile: { x: annCenter.x - w / 2, y: annCenter.y - h / 2, w, h },
    tileLabel: `${w}×${h}`,
    tracked: t,
    status: statusOf(eye),
  };
}
const L = computed(() => viewModel("L"));
const R = computed(() => viewModel("R"));

// Per-eye status (drag = we paused it; servo engaged = Tracking; armed-but-
// -missed = Lost; otherwise Idle).
function statusOf(eye: Eye): { text: string; tone: string } {
  if (drag[eye]) return { text: "Paused", tone: "warn" };
  if (telemetry.tracking[eye]) return { text: "Tracking", tone: "ok" };
  const t = telemetry.tracked[eye];
  if (t && !t.found) return { text: "Lost", tone: "danger" };
  return { text: "Idle", tone: "muted" };
}

// --- drawer controls --------------------------------------------------------
const TRACKER_OPTIONS: readonly SingleSelectOption<"hybrid" | "kcf">[] = [
  { value: "hybrid", label: "Hybrid", hint: "KCF fast path + template re-lock" },
  { value: "kcf", label: "KCF", hint: "single correlation-filter tracker" },
];
const trackerType = computed<"hybrid" | "kcf">({
  get: () => state.tracker_type,
  set: (v) => void session.call("setTrackerType", { type: v }),
});

// Square tile: one field driving both w and h, clamped to the tracker limits.
const tileSize = computed<number>({
  get: () => state.tile.w,
  set: (v) => {
    const n = Math.min(MAX_TILE, Math.max(MIN_TILE, Math.round(v || 0)));
    void session.call("setTile", { w: n, h: n });
  },
});

// PID gains — each field pushes the WHOLE gains object (setGains replaces all).
function gainProxy(k: keyof PidGains) {
  return computed<number>({
    get: () => state.gains[k],
    set: (v) => void session.call("setGains", { ...state.gains, [k]: v || 0 }),
  });
}
const kp = gainProxy("kp");
const ki = gainProxy("ki");
const kd = gainProxy("kd");

// One-shot camera capture (title-bar record button handles recording).
const capturing = ref(false);
async function runCapture(): Promise<void> {
  if (capturing.value) return;
  capturing.value = true;
  try {
    await capture.capture();
    window.foveaBridge.openDebugWindow("split-tracking", "capture");
  } finally {
    capturing.value = false;
  }
}

const drawer_height = ref(0);
</script>

<template>
  <div
    class="stage"
    :style="{ '--p': (drawer_height ? drawer_height + 20 : 0) + 'px' }"
  >
    <!-- LEFT FOVEA (primary) -->
    <div class="view primary">
      <StreamView class="stream" :title="ROLE.L" :payload="frameL" :theme="THEME.L">
        <!-- frame-center crosshair -->
        <line :x1="L.center.x" :y1="0" :x2="L.center.x" :y2="L.size.height"
          :stroke="THEME.L" :stroke-width="L.stroke" stroke-dasharray="6 6" opacity="0.5" />
        <line :x1="0" :y1="L.center.y" :x2="L.size.width" :y2="L.center.y"
          :stroke="THEME.L" :stroke-width="L.stroke" stroke-dasharray="6 6" opacity="0.5" />
        <!-- 512² tracker tile, centered on the tracked center (or drag marker) -->
        <rect :x="L.tile.x" :y="L.tile.y" :width="L.tile.w" :height="L.tile.h"
          fill="none" :stroke="THEME.L" :stroke-width="L.stroke" stroke-dasharray="12 8" />
        <text :x="L.tile.x + L.stroke * 2" :y="L.tile.y - L.stroke * 2"
          :font-size="L.size.height * 0.035" :fill="THEME.L" font-family="var(--font-mono)">
          {{ L.tileLabel }}
        </text>
        <!-- live tracked bbox + center dot (when found) -->
        <template v-if="L.tracked?.found">
          <rect v-if="L.tracked.bbox" :x="L.tracked.bbox.x" :y="L.tracked.bbox.y"
            :width="L.tracked.bbox.width" :height="L.tracked.bbox.height"
            fill="none" :stroke="THEME.L" :stroke-width="L.stroke * 1.5" />
          <circle v-if="L.tracked.center" :cx="L.tracked.center.x" :cy="L.tracked.center.y"
            :r="L.stroke * 3" :fill="THEME.L" />
        </template>
      </StreamView>
      <PosView
        :pos="L.marker"
        :lim="L.lim"
        :color="THEME.L"
        unit="px"
        style="width: 100%"
        :font-size="L.lim * 0.06"
        @select="(p) => onSelect('L', p)"
      />
      <div class="status" :class="L.status.tone">
        <span class="dot"></span>{{ ROLE.L }} — {{ L.status.text }}
      </div>
    </div>

    <!-- CENTER WIDE (context / secondary) -->
    <div class="view context">
      <StreamView class="stream" :title="ROLE.C" :payload="frameC" :theme="THEME.C" />
      <div class="context-note">context</div>
    </div>

    <!-- RIGHT FOVEA (primary) -->
    <div class="view primary">
      <StreamView class="stream" :title="ROLE.R" :payload="frameR" :theme="THEME.R">
        <line :x1="R.center.x" :y1="0" :x2="R.center.x" :y2="R.size.height"
          :stroke="THEME.R" :stroke-width="R.stroke" stroke-dasharray="6 6" opacity="0.5" />
        <line :x1="0" :y1="R.center.y" :x2="R.size.width" :y2="R.center.y"
          :stroke="THEME.R" :stroke-width="R.stroke" stroke-dasharray="6 6" opacity="0.5" />
        <rect :x="R.tile.x" :y="R.tile.y" :width="R.tile.w" :height="R.tile.h"
          fill="none" :stroke="THEME.R" :stroke-width="R.stroke" stroke-dasharray="12 8" />
        <text :x="R.tile.x + R.stroke * 2" :y="R.tile.y - R.stroke * 2"
          :font-size="R.size.height * 0.035" :fill="THEME.R" font-family="var(--font-mono)">
          {{ R.tileLabel }}
        </text>
        <template v-if="R.tracked?.found">
          <rect v-if="R.tracked.bbox" :x="R.tracked.bbox.x" :y="R.tracked.bbox.y"
            :width="R.tracked.bbox.width" :height="R.tracked.bbox.height"
            fill="none" :stroke="THEME.R" :stroke-width="R.stroke * 1.5" />
          <circle v-if="R.tracked.center" :cx="R.tracked.center.x" :cy="R.tracked.center.y"
            :r="R.stroke * 3" :fill="THEME.R" />
        </template>
      </StreamView>
      <PosView
        :pos="R.marker"
        :lim="R.lim"
        :color="THEME.R"
        unit="px"
        style="width: 100%"
        :font-size="R.lim * 0.06"
        @select="(p) => onSelect('R', p)"
      />
      <div class="status" :class="R.status.tone">
        <span class="dot"></span>{{ ROLE.R }} — {{ R.status.text }}
      </div>
    </div>
  </div>

  <Drawer v-model="drawer_height">
    <div class="controls fill">
      <!-- controller-absent / servo-blocked warning (tray idiom) -->
      <div v-if="telemetry.blocked" class="blocked">⚠ {{ telemetry.blocked }}</div>

      <div class="field">
        <span class="label">Tracker</span>
        <SingleSelect v-model="trackerType" :options="TRACKER_OPTIONS" />
      </div>

      <div class="field">
        <span class="label">Tile Size</span>
        <label class="num">
          <input type="number" v-model.number="tileSize" :min="MIN_TILE" :max="MAX_TILE" step="16" />
          <span class="unit">px ({{ MIN_TILE }}–{{ MAX_TILE }})</span>
        </label>
      </div>

      <div class="field">
        <span class="label">PID Gains</span>
        <div class="gains">
          <label><span>Kp</span><input type="number" v-model.number="kp" step="0.05" /></label>
          <label><span>Ki</span><input type="number" v-model.number="ki" step="0.01" /></label>
          <label><span>Kd</span><input type="number" v-model.number="kd" step="0.01" /></label>
        </div>
      </div>

      <div class="field">
        <span class="label">Status</span>
        <div class="status-rows">
          <div class="status" :class="L.status.tone"><span class="dot"></span>{{ ROLE.L }} — {{ L.status.text }}</div>
          <div class="status" :class="R.status.tone"><span class="dot"></span>{{ ROLE.R }} — {{ R.status.text }}</div>
        </div>
      </div>

      <div class="field">
        <span class="label">Capture</span>
        <button class="capture-btn" :disabled="capturing" @click="runCapture">
          {{ capturing ? "Capturing…" : "Capture Frame" }}
        </button>
      </div>
    </div>
  </Drawer>
</template>

<style scoped lang="scss">
.stage {
  --p: 0; // drawer-height bottom reserve (bound inline from drawer_height)
  position: relative;
  display: flex;
  justify-content: space-evenly;
  align-items: flex-start;
  flex-wrap: wrap;
  flex-direction: row;
  width: 100%;
  padding: 1em 0 calc(1em + var(--p)) 0;
  margin: 0;

  .view {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
  }

  .primary {
    width: 32vw;
    .stream {
      width: 32vw;
      height: 24vw;
    }
  }

  // Center wide is context-only: smaller and visually recessed.
  .context {
    width: 22vw;
    align-self: center;
    opacity: 0.85;
    .stream {
      width: 22vw;
      height: 16.5vw;
    }
    .context-note {
      margin-top: 0.4em;
      font-size: 0.75em;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-faint);
    }
  }
}

// Borderless-inline status pill (faint bg, no constant border).
.status {
  display: flex;
  align-items: center;
  gap: 0.6ch;
  margin-top: 0.4em;
  padding: 0.2em 0.7em;
  border-radius: 0.3em;
  font-size: 0.85em;
  font-family: var(--font-mono);
  background: var(--tint-1);
  color: var(--text-dim);

  .dot {
    width: 0.6em;
    height: 0.6em;
    border-radius: 50%;
    background: currentColor;
  }
  &.ok { color: var(--ok); }
  &.warn { color: var(--warn); }
  &.danger { color: var(--danger-text); }
  &.muted { color: var(--text-muted); }
}

.fill {
  width: 100%;
  height: 100%;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 0.9em;
  padding: 1em;
  overflow-y: auto;

  .blocked {
    color: var(--warn);
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 0.3em 0.5em;
    border-radius: 0.3em;
    background: color-mix(in srgb, var(--warn) 12%, transparent);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35em;

    .label {
      font-size: 0.8em;
      font-weight: 600;
      opacity: 0.7;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
  }

  // Borderless-inline inputs — faint bg, a border only on focus.
  input {
    background: var(--tint-1);
    border: 1px solid transparent;
    border-radius: 0.3em;
    color: inherit;
    font: inherit;
    padding: 0.3em 0.5em;
    width: 8ch;
    &:focus {
      outline: none;
      border-color: var(--accent);
    }
  }

  .num {
    display: flex;
    align-items: center;
    gap: 1ch;
    .unit { color: var(--text-muted); font-size: 0.85em; }
  }

  .gains {
    display: flex;
    gap: 1em;
    label {
      display: flex;
      align-items: center;
      gap: 0.6ch;
      span { color: var(--text-muted); font-size: 0.85em; }
      input { width: 6ch; }
    }
  }

  .status-rows {
    display: flex;
    flex-direction: column;
    gap: 0.35em;
    .status { margin-top: 0; }
  }

  .capture-btn {
    align-self: flex-start;
    padding: 0.45em 1.1em;
    border: none;
    border-radius: 0.3em;
    background: var(--tint-2);
    color: var(--text);
    cursor: pointer;
    &:hover:not(:disabled) { filter: brightness(1.2); }
    &:disabled { opacity: 0.5; cursor: not-allowed; }
  }
}
</style>
