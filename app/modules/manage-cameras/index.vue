<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  manage-cameras, migrated to the orchestrator. The orchestrator owns the
  cameras; this shell binds the `manage-cameras` session and renders a thin
  CameraConfig per discovered camera. No `core`/hardware access in the renderer.
-->
<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useSession } from "@lib/orchestrator/client";
import { manageCameras } from "./contract";
import CameraConfig from "./CameraConfig.vue";

const session = useSession(manageCameras, "manage-cameras");

// Fovea Pair link (P5): while cameras hold roles L and R, their columns
// collapse to readouts and one shared "Fovea Pair" panel edits both.
const pair = computed(() => session.telemetry.pair);
const variantFor = (serial: string) =>
  pair.value && (serial === pair.value.left || serial === pair.value.right)
    ? "linked"
    : "single";

onMounted(() => session.call("refresh", undefined));
</script>

<template>
    <!-- Duplicate fovea-role claims break the link silently otherwise —
         surface the reason where the pair panel would have been. -->
    <p v-if="session.telemetry.pair_blocked" class="pair-blocked">
        {{ session.telemetry.pair_blocked }}
    </p>
    <div class="cameras">
        <CameraConfig
            v-if="pair"
            variant="pair"
            :session="session"
        />
        <CameraConfig
            v-for="cam in session.telemetry.list"
            :key="cam.serial"
            :serial="cam.serial"
            :variant="variantFor(cam.serial)"
            :session="session"
        />
    </div>
</template>

<style scoped lang="scss">
.cameras {
    display: flex;
    // `safe center` + fixed-basis columns + overflow-x: the pair panel is a
    // 4th column on a 3-camera rig — existing columns must NOT shrink when the
    // link forms (layout stability); the row scrolls instead.
    justify-content: safe center;
    flex-wrap: nowrap;
    flex-direction: row;
    width: 100%;
    padding: 0.5em 0;
    margin: 0;
    overflow-y: scroll;
    overflow-x: auto;
    gap: 2.5vw;

    > * {
        flex: 0 0 30vw;
    }
}

.pair-blocked {
    margin: 0.5em auto 0;
    width: fit-content;
    padding: 0.3em 1ch;
    border: 1px solid var(--warn);
    border-radius: 4px;
    color: var(--warn);
    font-size: 0.85em;
}
</style>
