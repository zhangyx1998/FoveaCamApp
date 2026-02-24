<script setup lang="ts">
import { computed, ref } from "vue";
import PreviewMetaBlock from "./PreviewMetaBlock.vue";

type Meta = Record<string, any>;

const props = defineProps<{
  name: string;
  meta: Meta | [Meta | undefined][] | undefined;
}>();

const i = ref(0);
const isArray = computed(() => Array.isArray(props.meta));
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
  <PreviewMetaBlock :name="name" :meta="meta" v-if="meta !== null">
    <template v-if="isArray">
      <button @click="i = (i - 1 + meta.length) % meta.length">&lt;</button>
      <span>{{ i + 1 }} / {{ meta.length }}</span>
      <button @click="i = (i + 1) % meta.length">&gt;</button>
    </template>
  </PreviewMetaBlock>
</template>
