<script setup lang="ts">
import { computed } from "vue";
import type { FramePayload } from "@lib/orchestrator/protocol";
import { payloadToMat } from "@lib/orchestrator/client";
import { isEmpty } from "@lib/util";
import FrameView from "@src/components/FrameView.vue";

const props = defineProps<{
  name: string;
  image: FramePayload | Empty;
}>();

const image = computed(() =>
  isEmpty(props.image) ? props.image : payloadToMat(props.image),
);
</script>

<template>
  <FrameView :title="name" :mat="image" v-if="!isEmpty(image)" />
</template>
