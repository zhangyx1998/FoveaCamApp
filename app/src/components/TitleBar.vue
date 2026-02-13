<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { overlay } from "./Overlay.vue";

const props = defineProps<{
  title: string;
  subtitle?: string | null;
}>();

const emit = defineEmits<{
  (e: "back-to-home"): void;
  (e: "height", height: number): void;
}>();

watch(
  () => ({ ...props }),
  ({ title, subtitle }) => {
    if (subtitle) title += ` - ${subtitle}`;
    document.title = title;
  },
  { immediate: true },
);

function getRect(): Partial<DOMRect> {
  return (
    (navigator as any).windowControlsOverlay?.getTitlebarAreaRect?.() ??
    ({} as Partial<DOMRect>)
  );
}

const rect = ref<Partial<DOMRect>>(getRect());

const height = computed(
  () => (rect.value?.height ?? 40) + (rect.value?.top ?? 0),
);

watch(height, (h) => emit("height", h), { immediate: true });

function style(): Record<string, string> {
  const { height = 40, top = 0, left = 0 } = rect.value;
  return {
    height: height + top + "px",
    paddingTop: top + "px",
    fontSize: height * 0.4 + "px",
  };
}

function onResize() {
  rect.value = getRect();
}

onMounted(() => window.addEventListener("resize", onResize));
onUnmounted(() => window.removeEventListener("resize", onResize));
</script>

<template>
  <div class="title-bar" :style="style()">
    <div class="draggable" :style="{ width: rect.left + 'px' }"></div>
    <div class="title" @click="emit('back-to-home')">{{ title }}</div>
    <template v-if="subtitle" class="subtitle draggable">
      <div class="connector">-</div>
      <div class="subtitle">{{ subtitle }}</div>
    </template>
    <div class="draggable" style="width: 0; flex-grow: 1"></div>
    <div class="slot">
      <slot></slot>
    </div>
    <div class="draggable" style="width: 1ch"></div>
    <div class="overlay" v-show="overlay?.overlay">
      <component :is="overlay?.overlay" @exit="overlay = null"></component>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.title-bar {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  user-select: none;
  background-color: #111;
  border-bottom: 1px solid #222;
  flex-wrap: nowrap;
  overflow: visible;
  box-sizing: border-box;

  .draggable {
    -webkit-app-region: drag;
    height: 100%;
    margin: 0;
  }

  .title {
    color: white;
    position: relative;
    padding: 0.2ch 0.8ch;
    border-radius: 0.4ch;

    &:hover {
      cursor: pointer;
      background-color: #333;

      &:after {
        display: block;
      }
    }

    &:active {
      outline: 2px solid #08c;
    }

    &:after {
      display: none;
      pointer-events: none;
      position: absolute;
      top: calc(100% + 0.2em);
      left: 0;
      content: "Back to Home";
      width: 14ch;
      text-align: center;
      background-color: #111;
      border: 1px solid #333;
      font-style: italic;
      border-radius: 0.2em;
      color: gray;
      padding: 0.2em 0;
    }
  }

  .connector {
    pointer-events: none;
    color: #888;
  }

  .subtitle {
    color: #bbb;
    padding: 0.5ch;
  }

  .slot {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 1ch;
  }

  .overlay {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    height: calc(100vh - 100%);
    pointer-events: none;
    & > * {
      pointer-events: all;
    }
    display: flex;
    justify-content: center;
    align-items: center;
    flex-direction: column;
  }
}
</style>
