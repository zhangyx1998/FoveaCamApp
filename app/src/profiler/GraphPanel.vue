<!-- ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 --------------------------------------------------------- -->

<!-- Profiler pipeline graph (A-33, real-2 objective 1). Renders a
     `GraphTopology` (C-24 contract) as a live node graph via cytoscape +
     dagre (external lib granted; fully local, bundled by vite). Updates are
     INCREMENTAL: elements are diffed by id — a stats-only refresh mutates
     `data()` in place (labels/classes update, positions untouched); dagre
     re-layout runs ONLY when the (id, epoch)/edge membership actually
     changes, so the periodic poll never re-scrambles the layout.

     Interactions (D-item-3): nodes are user-draggable and re-layouts NEVER
     stomp a dragged node (dragfree positions are captured and re-applied —
     pure logic in graph-interactions.ts); zoom is ctrl+wheel ONLY (macOS
     pinch = ctrl+wheel; plain scroll keeps scrolling the page); whitespace
     drag pans; the canvas is vertically resizable (persisted) and can go
     fullscreen; hovering an edge shows its full flow detail (tx/rx/worst
     gap). -->

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faArrowsToDot,
  faCompress,
  faExpand,
  faRotateLeft,
} from "@fortawesome/free-solid-svg-icons";
import type { GraphTopology } from "@lib/orchestrator/graph-contract";
import {
  focusSet,
  membershipKey,
  toElements,
  type GraphElement,
  type HoverDetail,
} from "./graph-view";
import {
  GRAPH_HEIGHT_KEY,
  DEFAULT_GRAPH_HEIGHT,
  clampGraphHeight,
  parseGraphHeight,
  isZoomGesture,
  nextZoomLevel,
  reconcileDraggedPositions,
  type NodePosition,
} from "./graph-interactions";

cytoscape.use(dagre); // idempotent — cytoscape ignores re-registration

const props = defineProps<{ topology: GraphTopology | null }>();
const panelRoot = ref<HTMLDivElement | null>(null);
const container = ref<HTMLDivElement | null>(null);
let cy: cytoscape.Core | null = null;
let lastKey = "";

// Node fill by brick kind (open set — unknown kinds get the default slate).
// Tints are muted so the red SATURATED accent stays the loudest thing here.
const KIND_COLORS: Record<string, string> = {
  camera: "#2f6f4f",
  convert: "#2b5d8a",
  undistort: "#3a5d9c",
  kcf: "#7a5da8",
  detect: "#8a6d2b",
  fovea: "#2b8a83",
  composite: "#5a7d8a",
  view: "#555c66",
  record: "#8a2b4f",
  controller: "#a8742f",
};

const STYLE: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      shape: "round-rectangle",
      width: "label",
      height: "label",
      padding: "8px",
      "background-color": "#3a4048",
      "border-width": 1,
      "border-color": "#5a626d",
      label: "data(label)",
      "text-wrap": "wrap",
      "text-valign": "center",
      "text-halign": "center",
      "font-size": "9px",
      "font-family": "monospace",
      color: "#d8dde3",
      "text-max-width": "160px",
    },
  },
  ...Object.entries(KIND_COLORS).map(([kind, color]) => ({
    selector: `node[kind = "${kind}"]`,
    style: { "background-color": color },
  })),
  {
    // SATURATED — the same ≥0.9 semantics + red as the workload table.
    selector: "node.saturated",
    style: {
      "background-color": "#7a2230",
      "border-width": 2,
      "border-color": "#f56",
      color: "#ffd7dc",
    },
  },
  {
    selector: "edge",
    style: {
      width: 1.5,
      "line-color": "#4a525c",
      "target-arrow-color": "#4a525c",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      "arrow-scale": 0.8,
      label: "data(label)",
      "text-wrap": "wrap",
      "font-size": "8px",
      "font-family": "monospace",
      color: "#9aa3ad",
      "text-background-color": "#16181b",
      "text-background-opacity": 0.85,
      "text-background-padding": "2px",
    },
  },
  {
    // Edge WARNING accent (`edgeWarns`): a lossy link actively dropping OR a
    // FIFO link backpressured to its capacity. Red on line + caption; the
    // label itself carries only the effective rate (`edgeLabel`) — the drop /
    // queue detail lives in the hover card (`edgeDetail`).
    selector: "edge.dropping",
    style: {
      "line-color": "#a8323e",
      "target-arrow-color": "#a8323e",
      color: "#ff8896",
    },
  },
  {
    // Hover feedback (nodes + edges): a soft overlay halo instead of color
    // overrides, so semantic tints (kind fills, saturated red, dropping red)
    // stay untouched under the highlight.
    selector: ".hover",
    style: {
      "overlay-color": "#ffffff",
      "overlay-opacity": 0.12,
      "overlay-padding": 4,
    },
  },
  {
    // Hover FOCUS dim: everything OUTSIDE the hovered element's focus set
    // (graph-view's focusSet) recedes. Opacity ONLY — element opacity covers
    // body/line + label without clobbering the semantic tints or the .hover
    // overlay-halo (deliberately orthogonal channels). 0.2 clearly recedes
    // while the dimmed labels stay legible for orientation.
    selector: ".dimmed",
    style: {
      opacity: 0.2,
    },
  },
];

const LAYOUT = {
  name: "dagre",
  rankDir: "LR",
  nodeSep: 24,
  rankSep: 56,
  padding: 12,
  animate: false,
  fit: true,
} as unknown as cytoscape.LayoutOptions;

// User-dragged node positions (id → position, captured on cytoscape
// "dragfree"). Re-applied after every membership re-layout so the periodic
// topology refresh never stomps a node the user placed; auto-layout keeps
// owning every untouched node. Pruned when nodes leave the graph.
let dragged = new Map<string, NodePosition>();

function apply(t: GraphTopology): void {
  if (!cy) return;
  const els = toElements(t);
  lastEls = els;
  const key = membershipKey(t);
  const changed = key !== lastKey;
  lastKey = key;
  const wanted = new Set(els.map((e) => e.data.id));
  cy.batch(() => {
    // Remove departed elements first (removing a node also drops its edges).
    for (const el of cy!.elements().toArray()) if (!wanted.has(el.id())) el.remove();
    for (const el of els) {
      const existing = cy!.getElementById(el.data.id);
      if (existing.nonempty()) {
        existing.data(el.data);
        existing.classes(el.classes ?? "");
      } else {
        cy!.add({ group: el.group, data: el.data, classes: el.classes });
      }
    }
  });
  if (changed) {
    dragged = reconcileDraggedPositions(
      dragged,
      els.filter((e) => e.group === "nodes").map((e) => e.data.id),
    );
    cy.layout(LAYOUT).run(); // dagre, animate:false — synchronous
    for (const [id, pos] of dragged) {
      const node = cy.getElementById(id);
      if (node.nonempty()) node.position({ ...pos });
    }
  }
  // Hover/dim reconciliation: the diff above rewrites classes wholesale
  // (`existing.classes(...)`) and adds fresh elements without dim state — a
  // dimmed class must neither leak onto re-created elements nor vanish from
  // surviving ones mid-hover. If the hovered element itself churned away,
  // drop the whole hover state (its mouseout never fires); otherwise restore
  // the halo + re-derive the focus dim from the new element set.
  if (hoveredId && !wanted.has(hoveredId)) {
    hoveredId = null;
    hover.value = null;
    overNode = overEdge = false;
    settleCursor();
  }
  if (hoveredId) {
    cy.getElementById(hoveredId).addClass("hover");
    applyFocus();
  }
}

// --- Hover focus dim (user 2026-07-08) ----------------------------------------

// The elements last applied to the canvas — the pure `focusSet` computes the
// focus set from these (same ids as the live cytoscape elements).
let lastEls: GraphElement[] = [];
let hoveredId: string | null = null;

/** Dim everything outside the hovered element's focus set (batched — one
 *  style recalc per hover, not N). An unknown/absent hovered id degrades to
 *  clearing all dimming — never a fully-dimmed graph. */
function applyFocus(): void {
  if (!cy) return;
  const keep = hoveredId ? focusSet(lastEls, hoveredId) : new Set<string>();
  if (keep.size === 0) return clearFocus();
  cy.batch(() => {
    for (const el of cy!.elements().toArray())
      if (keep.has(el.id())) el.removeClass("dimmed");
      else el.addClass("dimmed");
  });
}

function clearFocus(): void {
  cy?.batch(() => cy!.elements().removeClass("dimmed"));
}

// --- Vertical resize (persisted) ---------------------------------------------

const height = ref(parseGraphHeight(localStorage.getItem(GRAPH_HEIGHT_KEY)));

// Center-anchored resize: `cy.resize()` alone keeps the top-left model point
// fixed, so growing/shrinking the canvas visually shoves the graph around
// its corner. Pan by half the size delta so the canvas CENTER stays put.
function resizeAnchored(): void {
  if (!cy) return;
  const w0 = cy.width();
  const h0 = cy.height();
  cy.resize();
  cy.panBy({ x: (cy.width() - w0) / 2, y: (cy.height() - h0) / 2 });
}

watch(height, () => requestAnimationFrame(resizeAnchored));

function persistHeight(): void {
  localStorage.setItem(GRAPH_HEIGHT_KEY, String(height.value));
}

function startResize(down: PointerEvent): void {
  const handle = down.currentTarget as HTMLElement;
  const startY = down.clientY;
  const startH = height.value;
  const move = (ev: PointerEvent): void => {
    height.value = clampGraphHeight(startH + (ev.clientY - startY));
  };
  const up = (): void => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    persistHeight();
  };
  handle.setPointerCapture(down.pointerId);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
}

function keyResize(ev: KeyboardEvent): void {
  const step = ev.key === "ArrowUp" ? -16 : ev.key === "ArrowDown" ? 16 : 0;
  if (step === 0) return;
  ev.preventDefault();
  height.value = clampGraphHeight(height.value + step);
  persistHeight();
}

// --- Zoom gating: ctrl+wheel only ---------------------------------------------

function onWheel(ev: WheelEvent): void {
  if (!cy || !container.value) return;
  if (!isZoomGesture(ev)) return; // plain scroll → let the page scroll
  ev.preventDefault();
  const rect = container.value.getBoundingClientRect();
  cy.zoom({
    level: nextZoomLevel(cy.zoom(), ev.deltaY),
    renderedPosition: { x: ev.clientX - rect.left, y: ev.clientY - rect.top },
  });
}

// --- Fullscreen ----------------------------------------------------------------

const isFullscreen = ref(false);
function toggleFullscreen(): void {
  if (document.fullscreenElement === panelRoot.value) void document.exitFullscreen();
  else void panelRoot.value?.requestFullscreen();
}
function onFullscreenChange(): void {
  isFullscreen.value = document.fullscreenElement === panelRoot.value;
  requestAnimationFrame(resizeAnchored);
}

// --- Fit / reset -------------------------------------------------------------

function fitView(): void {
  cy?.fit(undefined, 12);
}

function resetLayout(): void {
  dragged.clear();
  height.value = DEFAULT_GRAPH_HEIGHT;
  localStorage.removeItem(GRAPH_HEIGHT_KEY);
  requestAnimationFrame(() => {
    if (!cy) return;
    cy.resize();
    cy.layout(LAYOUT).run();
    cy.fit(undefined, 12); // reset zoom/pan
  });
}

// --- Hover detail card + cursor feedback --------------------------------------

// Labels stay minimal (node name / effective edge rate); the full metrics
// render in this card on hover — structured title + label/value rows
// (graph-view's HoverDetail), anchored above the hovered element.
const hover = ref<{ detail: HoverDetail; x: number; y: number } | null>(null);

// Cursor semantics over the canvas — each interaction gets its own cursor:
// whitespace pans → "grab" ("grabbing" while a button is down), nodes drag →
// "move" (4-way arrows, distinct from panning), edges carry the hover
// tooltip → "pointer". The graph is a <canvas>, so the cursor is driven from
// cytoscape events instead of CSS selectors.
const cursor = ref("grab");
let overEdge = false;
let overNode = false;
function settleCursor(): void {
  cursor.value = overEdge ? "pointer" : overNode ? "move" : "grab";
}
function onPointerDown(): void {
  cursor.value = overNode ? "move" : "grabbing";
}
function onPointerUp(): void {
  settleCursor();
}

onMounted(() => {
  cy = cytoscape({
    container: container.value,
    style: STYLE,
    // Interactions: nodes ARE draggable (no autoungrabify/autolock); zoom is
    // handled manually via the ctrl-gated wheel listener below; whitespace
    // drag pans (cytoscape default panning).
    userZoomingEnabled: false,
    userPanningEnabled: true,
  });
  cy.on("dragfree", "node", (evt) => {
    dragged.set(evt.target.id(), { ...evt.target.position() });
  });
  // Hover feedback: the .hover overlay halo (see STYLE) on both element
  // kinds + the detail card (node metrics / edge flow breakdown) + the focus
  // dim (everything outside the hovered neighborhood recedes).
  cy.on("mouseover", "node", (evt) => {
    evt.target.addClass("hover");
    overNode = true;
    settleCursor();
    hoveredId = evt.target.id();
    applyFocus();
    const detail = evt.target.data("detail") as HoverDetail | undefined;
    if (!detail) return;
    const bb = evt.target.renderedBoundingBox();
    hover.value = { detail, x: (bb.x1 + bb.x2) / 2, y: bb.y1 };
  });
  cy.on("mouseout", "node", (evt) => {
    evt.target.removeClass("hover");
    overNode = false;
    settleCursor();
    hoveredId = null;
    clearFocus();
    hover.value = null;
  });
  cy.on("mouseover", "edge", (evt) => {
    evt.target.addClass("hover");
    overEdge = true;
    settleCursor();
    hoveredId = evt.target.id();
    applyFocus();
    const detail = evt.target.data("detail") as HoverDetail | undefined;
    if (!detail) return;
    const p = evt.target.renderedMidpoint();
    hover.value = { detail, x: p.x, y: p.y };
  });
  cy.on("mouseout", "edge", (evt) => {
    evt.target.removeClass("hover");
    overEdge = false;
    settleCursor();
    hoveredId = null;
    clearFocus();
    hover.value = null;
  });
  // The card's anchor goes stale the moment the scene moves under it.
  cy.on("viewport", () => (hover.value = null));
  cy.on("grab", "node", () => (hover.value = null));
  container.value?.addEventListener("wheel", onWheel, { passive: false });
  container.value?.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  if (props.topology) apply(props.topology);
});

watch(
  () => props.topology,
  (t) => {
    if (t) apply(t);
  },
);

onBeforeUnmount(() => {
  container.value?.removeEventListener("wheel", onWheel);
  window.removeEventListener("pointerup", onPointerUp);
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  cy?.destroy();
  cy = null;
});
</script>

<template>
  <div
    ref="panelRoot"
    class="graph-panel"
    :class="{ fullscreen: isFullscreen }"
    :style="{ height: isFullscreen ? '100%' : height + 'px' }"
  >
    <div ref="container" class="canvas" :style="{ cursor }" />
    <div class="chips">
      <button
        type="button"
        @click="resetLayout"
        title="Forget dragged positions, re-run auto layout, reset zoom/pan and panel height"
        aria-label="Reset layout"
      >
        <Icon :icon="faRotateLeft" />
      </button>
      <button
        type="button"
        @click="fitView"
        title="Fit the whole graph into view"
        aria-label="Fit into view"
      >
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
      v-if="hover"
      class="hover-card"
      :style="{ left: hover.x + 'px', top: hover.y + 'px' }"
    >
      <div class="hover-title">{{ hover.detail.title }}</div>
      <table>
        <tbody>
          <tr v-for="[k, v] in hover.detail.rows" :key="k">
            <td class="k">{{ k }}</td>
            <td class="v">{{ v }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!topology || topology.nodes.length === 0" class="empty">
      No pipeline nodes yet — camera pipes and workload meters appear here while live.
    </div>
    <div
      class="resize-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize graph canvas (drag, or arrow up/down)"
      tabindex="0"
      title="Drag to resize the graph canvas"
      @pointerdown="startResize"
      @keydown="keyResize"
    />
  </div>
</template>

<style scoped lang="scss">
.graph-panel {
  position: relative;
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
  }

  .chips {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 6px;
    z-index: 2;

    // Icon-only chips (FontAwesome — no glyph-as-icon): square hit target,
    // meaning carried by the tooltip + aria-label. Boundary (border + fill)
    // shows on hover only, so the chips don't distract from the graph.
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

  .hover-card {
    position: absolute;
    transform: translate(-50%, calc(-100% - 8px));
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

  .resize-handle {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 10px;
    cursor: ns-resize;
    touch-action: none;
    z-index: 2;

    &::after {
      content: "";
      position: absolute;
      left: 50%;
      bottom: 3px;
      transform: translateX(-50%);
      width: 48px;
      height: 3px;
      border-radius: 2px;
      background: #2a2f36;
    }
    &:hover::after,
    &:focus-visible::after {
      background: #74b1be;
    }
    &:focus-visible {
      outline: none;
    }
  }
}
</style>
