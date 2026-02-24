<script setup lang="ts">
import { computed } from "vue";
import PreviewMetaItem from "./Item.vue";

const props = defineProps<{
  name: string;
  meta: Record<string, any>;
}>();

const data = computed(() => {
  try {
    return JSON.parse(JSON.stringify(props.meta));
  } catch (e) {
    return null;
  }
});
</script>

<template>
  <div class="meta">
    <div class="header">
      <div class="title">{{ name }}</div>
      <div>
        <slot></slot>
      </div>
    </div>
    <template v-if="data">
      <PreviewMetaItem
        v-for="[k, v] of Object.entries(data)"
        :key="k"
        :value="v"
      ></PreviewMetaItem>
    </template>
    <template v-else>
      <span class="error">Invalid Meta Data</span>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.meta {
  border: 1px solid #ccc;
  border-radius: 4px;
  padding: 8px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.title {
  font-weight: bold;
}

.error {
  color: red;
}
</style>
