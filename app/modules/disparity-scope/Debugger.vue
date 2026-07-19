<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Disparity-scope DEBUGGER: a pixel-COLUMN cross-reference stack — guide strip
  (row 1) over the two per-side correlation heatmaps (rows 2/3). The match kernel
  pads its heatmap back to the strip's dims, so rendering all three at the same
  CSS width aligns columns exactly. PASSIVE subscriber: only observes the
  app-owned session (never activates/drains); views are `:projectable="false"`.
-->
<script setup lang="ts">
import { THEME } from "@lib/camera-config";
import { useFrames, useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { disparity } from "./contract";
import StreamView from "@src/components/StreamView.vue";

// Passive: observe the app-owned session's state/telemetry without activating it.
const session = useSession(disparity, "disparity-scope", { passive: true });
const { state, telemetry } = session;

// Row 1: the guide-strip slice pipe.
const frameStrip = usePipeFrame(() =>
  state.serials?.C ? nodeId.slice(state.serials.C, "scope-strip") : null,
);
// Rows 2–3: the two per-side correlation heatmaps (haystack-aligned columns).
const { match_left: frameMatchLeft, match_right: frameMatchRight } = useFrames(
  session,
  ["match_left", "match_right"],
);
</script>

<template>
  <div class="debugger">
    <StreamView
      class="wide"
      title="Template Match Guide Strip"
      :payload="frameStrip"
      :projectable="false"
      width="100%"
    >
      <template v-if="frameStrip">
        <rect
          v-if="telemetry.match_center"
          v-bind="{ x: telemetry.match_center.rect.x, y: telemetry.match_center.rect.y, width: telemetry.match_center.rect.width, height: telemetry.match_center.rect.height }"
          :fill="THEME.C"
          opacity="0.2"
        />
        <rect
          v-if="telemetry.match_left"
          v-bind="{ x: telemetry.match_left.rect.x - 2, y: telemetry.match_left.rect.y - 2, width: telemetry.match_left.rect.width + 4, height: telemetry.match_left.rect.height + 4 }"
          fill="none"
          :stroke="THEME.L"
          stroke-width="2"
          opacity="0.4"
        />
        <rect
          v-if="telemetry.match_right"
          v-bind="{ x: telemetry.match_right.rect.x - 2, y: telemetry.match_right.rect.y - 2, width: telemetry.match_right.rect.width + 4, height: telemetry.match_right.rect.height + 4 }"
          fill="none"
          :stroke="THEME.R"
          stroke-width="2"
          opacity="0.4"
        />
      </template>
    </StreamView>
    <StreamView
      class="wide"
      title="Left Match (Red = Match, Blue = Mismatch)"
      :payload="frameMatchLeft.payload.value"
      :projectable="false"
      width="100%"
    />
    <StreamView
      class="wide"
      title="Right Match (Red = Match, Blue = Mismatch)"
      :payload="frameMatchRight.payload.value"
      :projectable="false"
      width="100%"
    />
  </div>
</template>

<style scoped lang="scss">
.debugger {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 1em;
  padding: 1em;

  .wide {
    width: 100%;
  }
}
</style>
