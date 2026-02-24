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
</script>

<template>
  <Block :name="name" :meta="meta" v-if="meta !== null">
    <RangeSelect v-if="count !== null" v-model="i" :count="count" />
  </Block>
</template>
