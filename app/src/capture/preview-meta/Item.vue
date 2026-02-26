<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";

const props = defineProps({
  key: String,
  value: null,
  indent: {
    type: Number,
    required: false,
    default: 2,
  },
  expand: {
    type: Boolean,
    required: false,
    default: true,
  },
});

const preview = computed(() => {
  try {
    return JSON.parse(JSON.stringify(props.value));
  } catch (e) {
    return String(props.value);
  }
});

const expand = ref(props.expand);
const is_object = computed(
  () => typeof props.value === "object" && props.value !== null,
);

const entries = computed(() => {
  if (!is_object.value) return [];
  return Object.entries(props.value);
});
</script>

<template>
  <div class="item" @click="expand = !expand">
    <div class="title">
      <span class="key">{{ key }}</span>
      <code class="preview" v-if="is_object && !expand">{{ preview }}</code>
      <code class="value" v-else>{{ value }}</code>
    </div>
    <Item
      v-if="is_object && expand"
      v-for="[k, v] in entries"
      :key="k"
      :value="v"
      :indent="props.indent + 2"
      :expand="false"
    ></Item>
  </div>
</template>

<style lang="scss" scoped>
.item {
  cursor: pointer;
  .title {
    display: flex;
    gap: 0.5em;
    flex-wrap: nowrap;
    white-space: nowrap;
    overflow: hidden;
    :not(.title) {
      text-overflow: ellipsis;
    }
    .key {
      font-weight: bold;
    }
    .preview {
      color: gray;
    }
  }
}
</style>
