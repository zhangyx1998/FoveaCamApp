<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Recursive renderer for the projection split tree (docs/proposals/
  projection-split-view.md deliverable 2). A leaf renders one ProjectionPane; a
  split lays its children out along `dir` with flex-grow == the child's ratio,
  interleaving draggable dividers. A divider drag reports the fraction it moved
  across the split's axis to the window controller, which clamps + re-normalizes
  the ratios in the pure reducer (`resizeDivider`). Vue-thin over that reducer;
  the component references itself for the recursion (Vue infers the name).
-->
<script setup lang="ts">
import { inject, ref } from "vue";
import { panes, type SplitTree } from "@lib/projection/split-tree";
import ProjectionPane from "./ProjectionPane.vue";
import { PROJECTION_CTL } from "./projection-context";

const props = defineProps<{ node: SplitTree; path: number[] }>();
const ctl = inject(PROJECTION_CTL)!;

const container = ref<HTMLElement | null>(null);

/** A stable key for a child subtree — its pane ids. Stable across a resize (so
 *  panes never remount mid-drag); changes only on a structural move. */
function nodeKey(node: SplitTree): string {
  return node.type === "leaf" ? node.pane.id : "s:" + panes(node).map((p) => p.id).join(",");
}

function startResize(e: MouseEvent, index: number): void {
  if (props.node.type !== "split") return;
  e.preventDefault();
  const el = container.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const dir = props.node.dir;
  const axis = dir === "row" ? rect.width : rect.height;
  if (axis <= 0) return;
  const start = dir === "row" ? e.clientX : e.clientY;
  let prevFrac = 0;
  const onMove = (ev: MouseEvent) => {
    const pos = dir === "row" ? ev.clientX : ev.clientY;
    const frac = (pos - start) / axis;
    ctl.resize(props.path, index, frac - prevFrac);
    prevFrac = frac;
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
</script>

<template>
  <ProjectionPane v-if="node.type === 'leaf'" :pane="node.pane" />
  <div v-else class="split" :class="node.dir" ref="container">
    <template v-for="(child, i) in node.children" :key="nodeKey(child)">
      <div class="cell" :style="{ flexGrow: node.ratios[i], flexBasis: '0' }">
        <SplitNode :node="child" :path="[...path, i]" />
      </div>
      <div
        v-if="i < node.children.length - 1"
        class="divider"
        :class="node.dir"
        @mousedown="startResize($event, i)"
      ></div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.split {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  &.row {
    flex-direction: row;
  }
  &.col {
    flex-direction: column;
  }
}

.cell {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

// Dividers: a thin grab strip with a wider invisible hit area. Snap feedback
// (instant color on hover) — no transition on the control path.
.divider {
  flex: 0 0 6px;
  background: var(--border);
  position: relative;
  z-index: 2;
  &:hover {
    background: var(--accent-bright);
  }
  &.row {
    cursor: col-resize;
  }
  &.col {
    cursor: row-resize;
  }
  // Widen the hit target beyond the visible strip.
  &::after {
    content: "";
    position: absolute;
    inset: -3px;
  }
}
</style>
