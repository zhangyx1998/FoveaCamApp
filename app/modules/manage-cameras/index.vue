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
import { onMounted } from "vue";
import { useSession } from "@lib/orchestrator/client";
import { manageCameras } from "./contract";
import CameraConfig from "./CameraConfig.vue";

const session = useSession(manageCameras, "manage-cameras");

onMounted(() => session.call("refresh", undefined));
</script>

<template>
    <p v-if="session.status.error" class="camera-error" role="alert">
        {{ session.status.error }}
    </p>
    <div class="cameras">
        <CameraConfig
            v-for="cam in session.telemetry.list"
            :key="cam.serial"
            :serial="cam.serial"
            :session="session"
            style="width: 30vw"
        />
    </div>
</template>

<style scoped lang="scss">
.camera-error {
    margin: 0.5em auto;
    max-width: 60ch;
    padding: 0.5em 1ch;
    border-radius: 0.5em;
    background: #c0392b22;
    border: 1px solid #c0392b;
    color: #ff9b8f;
    text-align: center;
    font-size: 0.9em;
}

.cameras {
    display: flex;
    justify-content: center;
    flex-wrap: nowrap;
    flex-direction: row;
    width: 100%;
    padding: 0.5em 0;
    margin: 0;
    overflow-y: scroll;
    gap: 2.5vw;
}
</style>
