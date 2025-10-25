<script setup lang="ts">
import { setAction } from "@src/components/Loading.vue";
import PosView from "@src/components/PosView.vue";
setAction("Running playground...");
await new Promise((resolve) => setTimeout(resolve, 60000));
</script>

<template>
    <PosView
        style="margin: 10px; width: min(80vh, 80vw)"
        :pos="{ x: 20, y: -40 }"
    ></PosView>
</template>
