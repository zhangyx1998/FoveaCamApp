<script setup lang="ts">
import { computed, ref } from "vue";
import Block from "./Block.vue";
import RangeSelect from "@src/components/RangeSelect.vue";

const props = defineProps<{
  name: string;
  meta: Record<string, any> | Record<string, any>[] | Empty;
}>();

const i = ref(0);
const count = computed(() =>
  Array.isArray(props.meta) ? props.meta.length : null,
);
const meta = computed(() => {
  const { meta } = props;
  if (meta === undefined) return null;
  if (Array.isArray(meta)) {
    if (meta.length === 0) return null;
    return meta[i.value]!;
  } else {
    return meta;
  }
});

// Matches the on-disk name of the shown index (save() pad rule).
const title = computed(() => {
  const { name, meta } = props;
  if (!Array.isArray(meta)) return name;
  const pad = Math.max(2, meta.length.toString().length);
  return `${name}/${i.value.toString().padStart(pad, "0")}`;
});
</script>

<template>
  <Block :name="title" :meta="meta" v-if="meta !== null">
    <RangeSelect v-if="count !== null" v-model="i" :count="count" />
  </Block>
</template>
