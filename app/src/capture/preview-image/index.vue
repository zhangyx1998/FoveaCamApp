<script setup lang="ts">
import { computed, ref } from "vue";
import { ImageResource } from "..";
import { isEmpty } from "@lib/util";
import RangeSelect from "@src/components/RangeSelect.vue";
import FrameView from "@src/components/FrameView.vue";

const props = defineProps<{
  name: string;
  image: ImageResource | Empty | (ImageResource | Empty)[];
}>();

const i = ref(0);
const count = computed(() =>
  Array.isArray(props.image) ? props.image.length : null,
);
const image = computed(() => {
  const { image } = props;
  if (isEmpty(image)) return image;
  if (Array.isArray(image)) {
    if (image.length === 0) return null;
    return image[i.value]!;
  } else {
    return image;
  }
});
</script>

<template>
  <FrameView :title="name" :mat="image" v-if="!isEmpty(image)">
    <RangeSelect v-if="count !== null" v-model="i" :count="count" />
  </FrameView>
</template>
