<!-- ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 --------------------------------------------------------- -->

<!-- Profiler pipeline graph — thin adapter (profiler-graph-handrolled.md). All
     rendering + interaction moved to the self-contained `<NodeGraph>` component
     (native SVG; cytoscape is gone). This layer only:
       - reduces the live `GraphTopology` to `GraphElement[]` (toElements, pure),
       - reads the app-wide hover-card mode LIVE over the shared config doc,
       - hosts <NodeGraph>.
     spec: docs/spec/profiler-graph.md -->

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { GraphTopology } from "@lib/orchestrator/graph-contract";
import { toElements } from "./graph-view";
import { useConfigRef } from "@lib/config";
import {
  coerceProfilerHoverCardMode,
  DEFAULT_PROFILER_HOVER_CARD_MODE,
  type ProfilerHoverCardMode,
} from "@lib/config-schema";
import NodeGraph from "../components/NodeGraph.vue";

const props = defineProps<{ topology: GraphTopology | null }>();

// Pure reduction — the panel diffs by element id inside NodeGraph.
const elements = computed(() => (props.topology ? toElements(props.topology) : []));

// Live hover-card mode over the shared `["config"]` doc. The profiler
// is its own BrowserWindow; `useConfigRef` reads that doc reactively and follows
// cross-window broadcasts. Not top-level-await'able here (no <Suspense> parent),
// so we mirror into a local ref + `watch` (disparity-scope drawer idiom).
const hoverCardMode = ref<ProfilerHoverCardMode>(DEFAULT_PROFILER_HOVER_CARD_MODE);
void useConfigRef("profiler_hover_card").then((r) => {
  hoverCardMode.value = coerceProfilerHoverCardMode(r.value);
  watch(r, (v) => (hoverCardMode.value = coerceProfilerHoverCardMode(v)));
});
</script>

<template>
  <NodeGraph :elements="elements" :hover-card-mode="hoverCardMode" />
</template>
