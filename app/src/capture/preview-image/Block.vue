<script setup lang="ts">
import { computed } from "vue";
import PreviewImageItem from "./Item.vue";

const props = defineProps<{
  name: string;
  image: Record<string, any>;
}>();

const data = computed(() => {
  try {
    return JSON.parse(JSON.stringify(props.image));
  } catch (e) {
    return null;
  }
});
</script>

<template>
  <div class="image">
    <div class="header">
      <div class="title">{{ name }}</div>
      <div>
        <slot></slot>
      </div>
    </div>
    <template v-if="data">
      <PreviewImageItem
        v-for="[k, v] of Object.entries(data)"
        :key="k"
        :value="v"
      ></PreviewImageItem>
    </template>
    <template v-else>
      <span class="error">Invalid Image Data</span>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.image {
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
