<!-- ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 --------------------------------------------------------- -->

<!-- Self-contained SVG node-graph (profiler-graph-handrolled.md — replaces the
     cytoscape+dagre panel). Renders `GraphElement[]` as native SVG: nodes are
     <rect>+<text> with a native busy-ring arc, edges are <path> stems (from
     graph-interactions.edgePath) with arrowheads, rate labels and warn/idle
     styling. All interactions are hand-rolled over the pure modules:
       - layout   → graph-layout.layoutDag (relayout gated on membership change)
       - viewport → graph-viewport (scroll pan, pointer-centered ctrl+wheel zoom,
                    resize refit — screen = model·zoom + pan, applied as one
                    <g transform="translate(pan) scale(zoom)">)
       - drag     → live edge re-lay on every pointermove (positions reactive)
       - hover    → distance-graded opacity (graph-view) + marching-dash flow +
                    a placement-driven detail card (hover-card-placement)
     spec: docs/spec/profiler-graph.md -->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faArrowsToDot,
  faCompress,
  faExpand,
  faRotateLeft,
} from "@fortawesome/free-solid-svg-icons";
import {
  effectiveOpacity,
  hoverDistances,
  IDLE_OPACITY,
  type GraphElement,
  type HoverDetail,
} from "../profiler/graph-view";
import {
  edgePath,
  isZoomGesture,
  laneOffset,
  nextZoomLevel,
  reconcileDraggedPositions,
  stemOffset,
  type NodePosition,
} from "../profiler/graph-interactions";
import { layoutDag } from "../profiler/graph-layout";
import {
  fitBox,
  panBy,
  resizeViewport,
  zoomAt,
  type Box,
  type Size,
  type Viewport,
} from "../profiler/graph-viewport";
import { utilizationLevel } from "../profiler/workload-view";
import {
  cornerPlacement,
  followPlacement,
  type HoverCardMode,
} from "../profiler/hover-card-placement";

const props = defineProps<{
  elements: GraphElement[];
  hoverCardMode: HoverCardMode;
}>();

const root = ref<HTMLDivElement | null>(null);
const container = ref<HTMLDivElement | null>(null);
const cardEl = ref<HTMLDivElement | null>(null);

// --- Node-size estimation (pre-render, from label metrics) -------------------
// Cytoscape's `width: label` measured the DOM; we ESTIMATE instead. Labels are
// monospace 9px (Cascadia Code, ~0.6em advance → ~5.4px/char) and, in practice,
// single-line (nodeLabel emits `role/action` tails with no spaces). Estimate:
// text box = longestLine·CHAR_W + 2·PAD_X wide (clamped MIN..MAX, matching the
// old 160px text-max-width), lineCount·LINE_H + 2·PAD_Y tall. Good enough to
// seed dagre ranks and draw the pill; exactness never mattered (dagre padded).
const CHAR_W = 5.4;
const PAD_X = 10;
const PAD_Y = 6;
const LINE_H = 12;
const MIN_W = 28;
const MAX_W = 172;

function estimateSize(label: string): Size {
  const lines = label.split("\n");
  const longest = lines.reduce((a, l) => Math.max(a, l.length), 0);
  const w = Math.min(MAX_W, Math.max(MIN_W, longest * CHAR_W + 2 * PAD_X));
  const h = lines.length * LINE_H + 2 * PAD_Y;
  return { w, h };
}

// --- Reactive model state ----------------------------------------------------
// Node CENTERS (model px) + estimated sizes, keyed by id. `reactive` so the edge
// paths + node transforms recompute the instant a drag mutates a position.
const positions = reactive<Record<string, NodePosition>>({});
const sizes = reactive<Record<string, Size>>({});
// User-dragged positions preserved across membership relayouts (ported gating).
let dragged = new Map<string, NodePosition>();
let lastKey = "";

const vp = ref<Viewport>({ zoom: 1, pan: { x: 0, y: 0 } });
const containerSize = ref<Size>({ w: 0, h: 0 });
let prevSize: Size = { w: 0, h: 0 };
let sizedOnce = false;

const nodeEls = computed(() => props.elements.filter((e) => e.group === "nodes"));
const edgeEls = computed(() => props.elements.filter((e) => e.group === "edges"));

/** Membership key from the element set (node ids + edge ids) — layout re-runs
 *  ONLY when this changes, so the 1 Hz stats refresh never re-scrambles a
 *  placed node. (graph-view.membershipKey owns the epoch-aware topology key;
 *  the element ids are what this component actually renders/diffs.) */
function membershipOf(els: GraphElement[]): string {
  const nodes = els.filter((e) => e.group === "nodes").map((e) => e.data.id).sort();
  const edges = els.filter((e) => e.group === "edges").map((e) => e.data.id).sort();
  return `${nodes.join("|")}//${edges.join("|")}`;
}

function relayout(els: GraphElement[]): void {
  const nEls = els.filter((e) => e.group === "nodes");
  const eEls = els.filter((e) => e.group === "edges");
  const liveIds = nEls.map((n) => n.data.id);
  const liveSet = new Set(liveIds);
  // Refresh sizes; prune departed.
  for (const id of Object.keys(sizes)) if (!liveSet.has(id)) delete sizes[id];
  for (const n of nEls) sizes[n.data.id] = estimateSize(String(n.data.label ?? ""));

  const res = layoutDag(
    nEls.map((n) => ({
      id: n.data.id,
      width: sizes[n.data.id]!.w,
      height: sizes[n.data.id]!.h,
    })),
    eEls.map((e) => ({ from: String(e.data.source), to: String(e.data.target) })),
    { nodeSep: 30, rankSep: 72, padding: 12 },
  );

  dragged = reconcileDraggedPositions(dragged, liveIds);
  for (const id of Object.keys(positions)) if (!liveSet.has(id)) delete positions[id];
  res.positions.forEach((p, id) => (positions[id] = { ...p }));
  // User-dragged nodes win over the fresh auto-layout (auto owns the rest).
  for (const [id, p] of dragged) if (liveSet.has(id)) positions[id] = { ...p };
}

// --- Live graph bbox (model px) ---------------------------------------------
// Recomputed from CURRENT node extents (incl. dragged nodes) so pan-clamp / fit
// always frame everything the user can see, not a stale layout bbox.
const GRAPH_PAD = 24;
const graphBox = computed<Box>(() => {
  const ids = nodeEls.value.map((n) => n.data.id);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const p = positions[id];
    const s = sizes[id];
    if (!p || !s) continue;
    minX = Math.min(minX, p.x - s.w / 2);
    minY = Math.min(minY, p.y - s.h / 2);
    maxX = Math.max(maxX, p.x + s.w / 2);
    maxY = Math.max(maxY, p.y + s.h / 2);
  }
  if (!Number.isFinite(minX)) {
    const c = containerSize.value;
    return { x: 0, y: 0, w: c.w || 1, h: c.h || 1 };
  }
  return {
    x: minX - GRAPH_PAD,
    y: minY - GRAPH_PAD,
    w: maxX - minX + 2 * GRAPH_PAD,
    h: maxY - minY + 2 * GRAPH_PAD,
  };
});

const transform = computed(
  () => `translate(${vp.value.pan.x} ${vp.value.pan.y}) scale(${vp.value.zoom})`,
);

// --- Node / edge view models -------------------------------------------------
const RING_R = 7;
const RING_C = 2 * Math.PI * RING_R;
const RING_TRACK = "#2a2f36";

function ringColor(util: number, saturated: boolean): string {
  const level = utilizationLevel(util);
  if (saturated || level === "high") return "#f56";
  if (level === "warn") return "#fa0";
  return "#0af";
}

// Node fill by brick kind (open set — unknown kinds get the default slate).
// Supplied to CSS as the `--kind` custom property (saturated/idle class rules
// override it).
const KIND_COLORS: Record<string, string> = {
  camera: "#2f6f4f",
  convert: "#2b5d8a",
  undistort: "#3a5d9c",
  kcf: "#7a5da8",
  imm: "#6a4fa8",
  compose: "#4f5da8",
  pid: "#4f7da8",
  detect: "#8a6d2b",
  fovea: "#2b8a83",
  composite: "#5a7d8a",
  view: "#555c66",
  renderer: "#48566a",
  record: "#8a2b4f",
  controller: "#a8742f",
};

interface NodeView {
  id: string;
  label: string;
  lines: string[];
  size: Size;
  x: number;
  y: number;
  kind: string;
  kindColor: string;
  roleColor?: string;
  saturated: boolean;
  idle: boolean;
  util?: number;
  ringDash?: string;
  ringColor?: string;
}

const nodeViews = computed<NodeView[]>(() =>
  nodeEls.value.map((el) => {
    const id = el.data.id;
    const p = positions[id] ?? { x: 0, y: 0 };
    const size = sizes[id] ?? estimateSize(String(el.data.label ?? ""));
    const cls = el.classes ?? "";
    const saturated = cls.includes("saturated");
    const idle = cls.includes("idle");
    const label = String(el.data.label ?? "");
    const util = typeof el.data.util === "number" ? (el.data.util as number) : undefined;
    let ringDash: string | undefined;
    let rColor: string | undefined;
    if (util !== undefined) {
      const u = Math.min(1, Math.max(0, util));
      const arc = u * RING_C;
      ringDash = `${arc.toFixed(2)} ${(RING_C - arc).toFixed(2)}`;
      rColor = ringColor(u, saturated);
    }
    return {
      id,
      label,
      lines: label.split("\n"),
      size,
      x: p.x,
      y: p.y,
      kind: String(el.data.kind ?? ""),
      kindColor: KIND_COLORS[String(el.data.kind ?? "")] ?? "#3a4048",
      roleColor: el.data.roleColor as string | undefined,
      saturated,
      idle,
      util,
      ringDash,
      ringColor: rColor,
    };
  }),
);

interface EdgeView {
  id: string;
  d: string;
  midX: number;
  midY: number;
  label: string;
  dropping: boolean;
  idle: boolean;
}

/** Cubic midpoint (t=0.5) of the same stem edgePath draws, for the rate label. */
function stemMid(s: NodePosition, t: NodePosition): NodePosition {
  const off = stemOffset(Math.hypot(t.x - s.x, t.y - s.y));
  const c1 = { x: s.x + off, y: s.y };
  const c2 = { x: t.x - off, y: t.y };
  return {
    x: 0.125 * (s.x + 3 * c1.x + 3 * c2.x + t.x),
    y: 0.125 * (s.y + 3 * c1.y + 3 * c2.y + t.y),
  };
}

const edgeViews = computed<EdgeView[]>(() =>
  edgeEls.value.map((el) => {
    const sId = String(el.data.source);
    const tId = String(el.data.target);
    const sc = positions[sId] ?? { x: 0, y: 0 };
    const tc = positions[tId] ?? { x: 0, y: 0 };
    const sw = (sizes[sId]?.w ?? 0) / 2;
    const tw = (sizes[tId]?.w ?? 0) / 2;
    const off = laneOffset(Number(el.data.lane ?? 0), Number(el.data.lanes ?? 1));
    const sp = { x: sc.x + sw, y: sc.y + off };
    const tp = { x: tc.x - tw, y: tc.y + off };
    const mid = stemMid(sp, tp);
    const cls = el.classes ?? "";
    return {
      id: el.data.id,
      d: edgePath(sp, tp),
      midX: mid.x,
      midY: mid.y,
      label: String(el.data.label ?? ""),
      dropping: cls.includes("dropping"),
      idle: cls.includes("idle"),
    };
  }),
);

// --- Distance-graded hover ----------------------------------------------------
const hoveredId = ref<string | null>(null);
const dragging = ref<string | null>(null);

const distances = computed(() =>
  hoveredId.value ? hoverDistances(props.elements, hoveredId.value) : null,
);

function opacityOf(id: string, idle: boolean): number {
  const d = distances.value;
  if (!d) return idle ? IDLE_OPACITY : 1;
  return effectiveOpacity(d.get(id) ?? Infinity, idle);
}
function zOf(id: string): number {
  const d = distances.value;
  if (!d) return 0;
  const dist = d.get(id);
  return dist === undefined ? 0 : Math.max(0, 100 - dist);
}
/** A hover-highlighted (BFS ≤ 1), non-idle edge marches source → target. */
function marching(id: string, idle: boolean): boolean {
  const d = distances.value;
  return !!d && !idle && (d.get(id) ?? Infinity) <= 1;
}

// --- Hover detail card --------------------------------------------------------
const card = ref<{ detail: HoverDetail; x: number; y: number } | null>(null);
const lastCursor = ref<NodePosition>({ x: 0, y: 0 });

function detailOf(id: string): HoverDetail | null {
  const el = props.elements.find((e) => e.data.id === id);
  const d = el?.data.detail as HoverDetail | undefined;
  return d ?? null;
}

/** Screen bbox (container-rel px) of an element — node pill or edge stem. */
function screenBox(id: string): Box {
  const z = vp.value.zoom;
  const pan = vp.value.pan;
  const p = positions[id];
  if (p && sizes[id]) {
    const s = sizes[id]!;
    return {
      x: (p.x - s.w / 2) * z + pan.x,
      y: (p.y - s.h / 2) * z + pan.y,
      w: s.w * z,
      h: s.h * z,
    };
  }
  // Edge: bbox over its two endpoints.
  const ev = edgeViews.value.find((e) => e.id === id);
  if (ev) {
    const x = ev.midX * z + pan.x;
    const y = ev.midY * z + pan.y;
    return { x: x - 2, y: y - 2, w: 4, h: 4 };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

/** Estimate the card's rendered size (falls back before it mounts). */
function cardSize(detail: HoverDetail): Size {
  const el = cardEl.value;
  if (el && el.offsetWidth > 0) return { w: el.offsetWidth, h: el.offsetHeight };
  const cols = detail.rows.reduce(
    (a, [k, v]) => Math.max(a, k.length + String(v).length + 3),
    detail.title.length,
  );
  return { w: Math.min(360, cols * 6.5 + 24), h: (detail.rows.length + 1) * 15 + 18 };
}

function updateCard(): void {
  const id = hoveredId.value;
  if (!id) {
    card.value = null;
    return;
  }
  const detail = detailOf(id);
  if (!detail) {
    card.value = null;
    return;
  }
  const c = containerSize.value;
  const sz = cardSize(detail);
  const pos =
    props.hoverCardMode === "corner"
      ? cornerPlacement(screenBox(id), lastCursor.value, sz, c)
      : followPlacement(lastCursor.value, sz, c);
  card.value = { detail, x: pos.x, y: pos.y };
}

function onEnter(id: string): void {
  hoveredId.value = id;
  updateCard();
}
function onLeave(): void {
  hoveredId.value = null;
  card.value = null;
}

// The card DOM only exists after `card` is set; measure it once mounted and
// re-place so the flip decision uses the real size (no visible jump — the card
// starts hidden until placed).
watch(card, () => {
  if (card.value)
    requestAnimationFrame(() => {
      const el = cardEl.value;
      if (!el || !card.value || !hoveredId.value) return;
      const detail = card.value.detail;
      const c = containerSize.value;
      const sz = { w: el.offsetWidth, h: el.offsetHeight };
      const pos =
        props.hoverCardMode === "corner"
          ? cornerPlacement(screenBox(hoveredId.value), lastCursor.value, sz, c)
          : followPlacement(lastCursor.value, sz, c);
      card.value = { detail, x: pos.x, y: pos.y };
    });
});
watch(() => props.hoverCardMode, updateCard);

// --- Pointer / wheel wiring ---------------------------------------------------
function containerRect(): DOMRect {
  return container.value!.getBoundingClientRect();
}

function onPointerMove(ev: PointerEvent): void {
  const r = containerRect();
  lastCursor.value = { x: ev.clientX - r.left, y: ev.clientY - r.top };
  if (hoveredId.value && props.hoverCardMode === "follow") updateCard();
}

function onWheel(ev: WheelEvent): void {
  ev.preventDefault(); // the graph never scrolls the tab
  const r = containerRect();
  const c = containerSize.value;
  if (isZoomGesture(ev)) {
    // ctrl+wheel (macOS pinch) → zoom centered on the pointer.
    const pointer = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    vp.value = zoomAt(vp.value, nextZoomLevel(vp.value.zoom, ev.deltaY), pointer, c, graphBox.value);
  } else {
    // Plain wheel (trackpad two-finger) → X/Y pan, clamped.
    vp.value = panBy(vp.value, -ev.deltaX, -ev.deltaY, c, graphBox.value);
  }
  if (hoveredId.value) updateCard();
}

// Node drag: live edge re-lay on EVERY pointermove — positions are
// reactive, so edge paths recompute per frame. Zoom is captured at grab.
function onNodePointerDown(ev: PointerEvent, id: string): void {
  ev.stopPropagation();
  ev.preventDefault();
  const start = { x: ev.clientX, y: ev.clientY };
  const orig = { ...(positions[id] ?? { x: 0, y: 0 }) };
  const z = vp.value.zoom;
  dragging.value = id;
  const move = (e: PointerEvent): void => {
    positions[id] = { x: orig.x + (e.clientX - start.x) / z, y: orig.y + (e.clientY - start.y) / z };
    if (hoveredId.value) updateCard();
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    dragging.value = null;
    dragged.set(id, { ...positions[id]! });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// --- Viewport resize: ResizeObserver drives the refit -------------------------
function onResize(): void {
  const el = container.value;
  if (!el) return;
  const next = { w: el.clientWidth, h: el.clientHeight };
  if (next.w === 0 || next.h === 0) return; // hidden tab / 0×0 — wait for reveal
  containerSize.value = next;
  if (!sizedOnce) {
    // First non-zero box (tab reveal / mount) → fit the WHOLE graph.
    sizedOnce = true;
    prevSize = next;
    vp.value = fitBox(graphBox.value, next, 12);
    return;
  }
  vp.value = resizeViewport(vp.value, prevSize, next, graphBox.value);
  prevSize = next;
  if (hoveredId.value) updateCard();
}
let resizeObserver: ResizeObserver | null = null;

// --- Chips: fit / reset / fullscreen -----------------------------------------
function fitView(): void {
  const c = containerSize.value;
  if (c.w === 0 || c.h === 0) return;
  vp.value = fitBox(graphBox.value, c, 12);
}

function resetLayout(): void {
  // Forget dragged positions, re-run auto layout, refit (NO height — the panel
  // is not resizable).
  dragged.clear();
  relayout(props.elements);
  requestAnimationFrame(fitView);
}

const isFullscreen = ref(false);
function toggleFullscreen(): void {
  if (document.fullscreenElement === root.value) void document.exitFullscreen();
  else void root.value?.requestFullscreen();
}
function onFullscreenChange(): void {
  isFullscreen.value = document.fullscreenElement === root.value;
  // The ResizeObserver catches the box change and refits.
}

// --- Lifecycle ---------------------------------------------------------------
watch(
  () => props.elements,
  (els) => {
    const key = membershipOf(els);
    if (key !== lastKey) {
      lastKey = key;
      relayout(els);
      // Reframe on a membership change once the container has a real box
      // (first reveal is fit by the ResizeObserver).
      if (sizedOnce) requestAnimationFrame(fitView);
    }
  },
  { immediate: true },
);

onMounted(() => {
  container.value?.addEventListener("wheel", onWheel, { passive: false });
  resizeObserver = new ResizeObserver(onResize);
  if (container.value) resizeObserver.observe(container.value);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  onResize();
});

onBeforeUnmount(() => {
  container.value?.removeEventListener("wheel", onWheel);
  resizeObserver?.disconnect();
  resizeObserver = null;
  document.removeEventListener("fullscreenchange", onFullscreenChange);
});
</script>

<template>
  <div ref="root" class="node-graph" :class="{ fullscreen: isFullscreen }">
    <div
      ref="container"
      class="canvas"
      :class="{ dragging: dragging !== null }"
      @pointermove="onPointerMove"
      @pointerleave="onLeave"
    >
      <svg class="svg" :width="containerSize.w" :height="containerSize.h">
        <defs>
          <!-- Shared arrowhead — `context-stroke` paints it the edge's own color
               (Chromium/Electron), so warn-red + idle edges get matching heads. -->
          <marker
            id="ng-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
          </marker>
        </defs>
        <g :transform="transform">
          <!-- Edges (behind nodes) -->
          <g
            v-for="e in edgeViews"
            :key="e.id"
            class="edge"
            :style="{ opacity: opacityOf(e.id, e.idle) }"
            @pointerenter="onEnter(e.id)"
            @pointerleave="onLeave"
          >
            <path class="edge-hit" :class="{ hovered: hoveredId === e.id }" :d="e.d" />
            <path
              class="edge-line"
              :class="{ dropping: e.dropping, idle: e.idle, marching: marching(e.id, e.idle) }"
              :d="e.d"
              marker-end="url(#ng-arrow)"
            />
            <template v-if="e.label">
              <rect
                class="edge-label-bg"
                :x="e.midX - (e.label.length * 4) / 2 - 2"
                :y="e.midY - 6"
                :width="e.label.length * 4 + 4"
                :height="11"
                rx="2"
              />
              <text
                class="edge-label"
                :class="{ dropping: e.dropping, idle: e.idle }"
                :x="e.midX"
                :y="e.midY + 3"
                text-anchor="middle"
              >
                {{ e.label }}
              </text>
            </template>
          </g>

          <!-- Nodes -->
          <g
            v-for="n in nodeViews"
            :key="n.id"
            class="node"
            :class="{ saturated: n.saturated, idle: n.idle, grabbed: dragging === n.id }"
            :style="{
              '--kind': n.kindColor,
              '--role': n.roleColor,
              opacity: opacityOf(n.id, n.idle),
            }"
            :transform="`translate(${n.x} ${n.y})`"
            @pointerenter="onEnter(n.id)"
            @pointerleave="onLeave"
            @pointerdown="onNodePointerDown($event, n.id)"
          >
            <rect
              v-if="hoveredId === n.id"
              class="halo"
              :x="-n.size.w / 2 - 4"
              :y="-n.size.h / 2 - 4"
              :width="n.size.w + 8"
              :height="n.size.h + 8"
              rx="8"
            />
            <rect
              class="pill"
              :x="-n.size.w / 2"
              :y="-n.size.h / 2"
              :width="n.size.w"
              :height="n.size.h"
              rx="5"
            />
            <text class="node-label" text-anchor="middle" :y="-(n.lines.length - 1) * (LINE_H / 2)">
              <tspan
                v-for="(line, i) in n.lines"
                :key="i"
                x="0"
                :dy="i === 0 ? 3 : LINE_H"
              >{{ line }}</tspan>
            </text>
            <!-- Busy ring: native arc pinned to the top-right corner. -->
            <g v-if="n.ringDash" :transform="`translate(${n.size.w / 2} ${-n.size.h / 2})`">
              <circle :r="RING_R" fill="none" :stroke="RING_TRACK" stroke-width="3" />
              <circle
                :r="RING_R"
                fill="none"
                :stroke="n.ringColor"
                stroke-width="3"
                stroke-linecap="round"
                :stroke-dasharray="n.ringDash"
                transform="rotate(-90)"
              />
            </g>
          </g>
        </g>
      </svg>
    </div>

    <div class="chips">
      <button
        type="button"
        @click="resetLayout"
        title="Forget dragged positions, re-run auto layout, reset zoom/pan"
        aria-label="Reset layout"
      >
        <Icon :icon="faRotateLeft" />
      </button>
      <button type="button" @click="fitView" title="Fit the whole graph into view" aria-label="Fit into view">
        <Icon :icon="faArrowsToDot" />
      </button>
      <button
        type="button"
        @click="toggleFullscreen"
        :title="isFullscreen ? 'Exit full screen' : 'Show the graph full screen'"
        :aria-label="isFullscreen ? 'Exit full screen' : 'Full screen'"
      >
        <Icon :icon="isFullscreen ? faCompress : faExpand" />
      </button>
    </div>

    <div
      v-if="card"
      ref="cardEl"
      class="hover-card"
      :style="{ left: card.x + 'px', top: card.y + 'px' }"
    >
      <div class="hover-title">{{ card.detail.title }}</div>
      <table>
        <tbody>
          <tr v-for="[k, v] in card.detail.rows" :key="k">
            <td class="k">{{ k }}</td>
            <td class="v">{{ v }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="nodeEls.length === 0" class="empty">
      No pipeline nodes yet — camera pipes and workload meters appear here while live.
    </div>
  </div>
</template>

<style scoped lang="scss">
.node-graph {
  position: relative;
  width: 100%;
  height: 100%;
  border: 1px solid #23262b;
  border-radius: 6px;
  background: #101215;
  overflow: hidden;

  &.fullscreen {
    border: none;
    border-radius: 0;
  }

  .canvas {
    width: 100%;
    height: 100%;
    touch-action: none;
    cursor: default;
    &.dragging {
      cursor: grabbing;
    }
  }

  .svg {
    display: block;
  }

  // --- Edges -----------------------------------------------------------------
  .edge {
    // A wide transparent hit path makes the thin stem easy to hover; it lights
    // up as a soft halo (the cytoscape overlay, ported) on hover.
    .edge-hit {
      fill: none;
      stroke: transparent;
      stroke-width: 12;
      &.hovered {
        stroke: #ffffff1f;
      }
    }
    .edge-line {
      fill: none;
      stroke: #4a525c;
      stroke-width: 1.5;
      &.dropping {
        stroke: #a8323e;
      }
      // IDLE link: static dashed + desaturated (no march — no flow to animate).
      &.idle {
        stroke: #33383f;
        stroke-dasharray: 5 4;
      }
      // Marching flow: hover-highlighted active edges only.
      &.marching {
        stroke-dasharray: 6 4;
        animation: ng-march 0.6s linear infinite;
      }
    }
    .edge-label {
      fill: #9aa3ad;
      font: 8px var(--font-mono, monospace);
      &.dropping {
        fill: #ff8896;
      }
      &.idle {
        fill: #888;
      }
    }
    .edge-label-bg {
      fill: #16181b;
      opacity: 0.85;
    }
  }

  // stroke-dashoffset marches negative → dashes advance source → target.
  @keyframes ng-march {
    to {
      stroke-dashoffset: -20;
    }
  }

  // --- Nodes -----------------------------------------------------------------
  .node {
    cursor: grab;
    &.grabbed {
      cursor: grabbing;
    }
    .pill {
      // `--kind` (per-node inline custom property) is the semantic kind fill;
      // saturated/idle class rules below override it. `--role` tints the border
      // (L/C/R identity), default slate when unset.
      fill: var(--kind, #3a4048);
      stroke: var(--role, #5a626d);
      stroke-width: 1;
    }
    .node-label {
      fill: #d8dde3;
      font: 9px var(--font-mono, monospace);
      pointer-events: none;
      user-select: none;
    }
    // Hover halo — soft white overlay so semantic tints stay untouched.
    .halo {
      fill: #ffffff1f;
      pointer-events: none;
    }

    // SATURATED — same ≥0.9 red as the workload table (border wins over --role).
    &.saturated {
      .pill {
        fill: #7a2230;
        stroke: #f56;
        stroke-width: 2;
      }
      .node-label {
        fill: #ffd7dc;
      }
    }
    // IDLE — desaturated slate, dimmed caption (resting opacity is applied inline
    // via effectiveOpacity so the hover gradient composes with it).
    &.idle {
      .pill {
        fill: #2a2e33;
        stroke: #3a3f46;
      }
      .node-label {
        fill: #888;
      }
    }
  }

  // --- Chips (top-right) -----------------------------------------------------
  .chips {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 6px;
    z-index: 2;

    button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 22px;
      background: transparent;
      color: #9aa3ad;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 0;
      font-size: 0.7rem;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;

      &:hover {
        background: #1e2126;
        border-color: #2a2f36;
        color: #d8dde3;
      }
      &:focus-visible {
        outline: 1px solid #74b1be;
      }
    }
  }

  // --- Hover detail card (positioned by hover-card-placement) ----------------
  .hover-card {
    position: absolute;
    z-index: 3;
    pointer-events: none;
    background: #16181bf2;
    border: 1px solid #2a2f36;
    border-radius: 5px;
    padding: 6px 9px;
    font-size: 0.68rem;
    color: #c3cad2;
    max-width: 32rem;

    .hover-title {
      font-family: var(--font-mono);
      color: #d8dde3;
      white-space: nowrap;
      margin-bottom: 3px;
      padding-bottom: 3px;
      border-bottom: 1px solid #23262b;
    }

    table {
      border-collapse: collapse;
      td {
        padding: 1px 0;
        vertical-align: baseline;
        white-space: nowrap;
      }
      .k {
        color: #7d8590;
        padding-right: 1.2ch;
        text-align: right;
      }
      .v {
        font-family: var(--font-mono);
        color: #c3cad2;
      }
    }
  }

  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #667;
    font-size: 0.85rem;
    pointer-events: none;
  }
}
</style>
