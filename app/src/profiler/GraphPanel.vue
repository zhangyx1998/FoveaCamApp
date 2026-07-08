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
     changes, so the 1 Hz poll never re-scrambles the layout. -->

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import type { GraphTopology } from "@lib/orchestrator/graph-contract";
import { membershipKey, toElements } from "./graph-view";

cytoscape.use(dagre); // idempotent — cytoscape ignores re-registration

const props = defineProps<{ topology: GraphTopology | null }>();
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
      "font-size": "8px",
      "font-family": "monospace",
      color: "#9aa3ad",
      "text-background-color": "#16181b",
      "text-background-opacity": 0.85,
      "text-background-padding": "2px",
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

function apply(t: GraphTopology): void {
  if (!cy) return;
  const els = toElements(t);
  const key = membershipKey(t);
  const changed = key !== lastKey;
  lastKey = key;
  cy.batch(() => {
    const wanted = new Set(els.map((e) => e.data.id));
    // Remove departed elements first (removing a node also drops its edges).
    for (const el of cy!.elements().toArray()) if (!wanted.has(el.id())) el.remove();
    for (const el of els) {
      const existing = cy!.getElementById(el.data.id);
      if (existing.nonempty()) {
        existing.data(el.data);
        if (el.group === "nodes") existing.classes(el.classes ?? "");
      } else {
        cy!.add({ group: el.group, data: el.data, classes: el.classes });
      }
    }
  });
  if (changed) cy.layout(LAYOUT).run();
}

onMounted(() => {
  cy = cytoscape({
    container: container.value,
    style: STYLE,
    wheelSensitivity: 0.2,
    // Read-only viz: nodes aren't draggable (layout owns positions), but
    // pan/zoom stay on for inspecting a crowded graph.
    autoungrabify: true,
  });
  if (props.topology) apply(props.topology);
});

watch(
  () => props.topology,
  (t) => {
    if (t) apply(t);
  },
);

onBeforeUnmount(() => {
  cy?.destroy();
  cy = null;
});
</script>

<template>
  <div class="graph-panel">
    <div ref="container" class="canvas" />
    <div v-if="!topology || topology.nodes.length === 0" class="empty">
      No pipeline nodes yet — camera pipes and workload meters appear here while live.
    </div>
  </div>
</template>

<style scoped lang="scss">
.graph-panel {
  position: relative;
  height: 380px;
  border: 1px solid #23262b;
  border-radius: 6px;
  background: #101215;
  overflow: hidden;

  .canvas {
    width: 100%;
    height: 100%;
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
