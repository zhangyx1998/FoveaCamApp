<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Single-capture, migrated to the orchestrator. Thin client over the `liveview`
  session: pick a camera, the orchestrator opens it (restoring its persisted
  config) and streams frames here. No `core`/hardware access in the renderer.
-->
<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useSession, usePipeFrame, payloadToMat } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { liveview } from "./contract";
import FrameView from "@src/components/FrameView.vue";

const session = useSession(liveview, "liveview");
const { state, telemetry } = session;
// real-1c: live view off the selected camera's native pipe (not `session.frame`).
const frame = usePipeFrame(() => (state.serial ? nodeId.convert(state.serial) : null));
const mat = computed(() => payloadToMat(frame.value));

onMounted(() => session.call("refresh", undefined));
</script>

<template>
  <div class="content">
    <FrameView class="stream" title="Camera View" :mat="mat" theme="yellow" />
    <div class="controls">
      <label>
        Camera
        <select v-model="state.serial">
          <option value="">Select a Camera</option>
          <option v-for="c in telemetry.cameras" :key="c.serial" :value="c.serial">
            {{ c.vendor }} {{ c.model }} ({{ c.serial }})
          </option>
        </select>
      </label>
    </div>
  </div>
</template>

<style scoped lang="scss">
.content {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  width: 100%;
  height: 100%;
  --size: min(90vw, 120vh);
}
.stream {
  width: var(--size);
  height: calc(var(--size) * 3 / 4);
  margin: 2rem;
}
.controls {
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  gap: 1em;
}
</style>
