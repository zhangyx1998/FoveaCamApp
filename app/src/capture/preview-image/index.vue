<script setup lang="ts">
import { computed, ref } from "vue";
import type { FramePayload } from "@lib/orchestrator/protocol";
import { payloadToMat } from "@lib/orchestrator/client";
import { isEmpty } from "@lib/util";
import RangeSelect from "@src/components/RangeSelect.vue";
import FrameView from "@src/components/FrameView.vue";

const props = defineProps<{
  name: string;
  image: FramePayload | Empty | (FramePayload | Empty)[];
}>();

const i = ref(0);
const count = computed(() =>
  Array.isArray(props.image) ? props.image.length : null,
);
const image = computed(() => {
  const { image } = props;
  const payload = isEmpty(image)
    ? image
    : Array.isArray(image)
      ? (image.length === 0 ? null : (image[image.length - 1 - i.value] ?? null))
      : image;
  return isEmpty(payload) ? payload : payloadToMat(payload);
});
</script>

<template>
  <FrameView :title="name" :mat="image" v-if="!isEmpty(image)">
    <RangeSelect v-if="count !== null" v-model="i" :count="count" />
  </FrameView>
</template>
