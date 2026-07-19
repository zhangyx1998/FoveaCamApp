<script setup lang="ts">
import { computed, ref, useTemplateRef, watch, onUnmounted } from "vue";
import { register } from "./telecanvas/registry";
const container = useTemplateRef<SVGSVGElement>("container");
const content = ref<string>("");
const observer = computed(() => {
  const el = container.value;
  if (!el) return null;
  const obs = new MutationObserver(() => {
    content.value = el.innerHTML;
  });
  obs.observe(el, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  content.value = el.innerHTML;
  return obs;
});
watch(observer, (_, prev) => prev?.disconnect());
const unregister = register(content);
onUnmounted(() => {
  unregister();
  observer.value?.disconnect();
});
</script>

<template>
  <svg ref="container" style="display: none"><slot></slot></svg>
</template>
