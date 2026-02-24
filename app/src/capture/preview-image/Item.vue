<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import "highlight.js/styles/github.css";

hljs.registerLanguage("json", json);

const props = defineProps({
  key: String,
  value: null,
});

const preview = computed(() => {
  try {
    return JSON.parse(JSON.stringify(props.value));
  } catch (e) {
    return String(props.value);
  }
});

const full = computed(() => JSON.stringify(props.value, null, 2));
const expand = ref(false);
const codeEl = ref<HTMLElement | null>(null);

const highlight = async () => {
  if (!expand.value) return;
  await nextTick();
  const el = codeEl.value;
  if (!el) return;
  el.textContent = full.value;
  hljs.highlightElement(el);
};

watch([full, expand], highlight);
onMounted(highlight);
</script>

<template>
  <div class="item" @click="expand = !expand">
    <div class="title">
      <span class="key">{{ key }}</span>
      <code class="preview" v-if="!expand">{{ preview }}</code>
    </div>
    <pre class="full" v-if="expand">
      <code ref="codeEl" class="language-json"></code>
    </pre>
  </div>
</template>

<style lang="scss" scoped>
.item {
  cursor: pointer;
  .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    .key {
      font-weight: bold;
    }
    .preview {
      margin-left: 0.5em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
  .full {
    margin-top: 0.5em;
    padding: 0.5em;
    border-radius: 4px;
    overflow: auto;
  }
}
</style>
