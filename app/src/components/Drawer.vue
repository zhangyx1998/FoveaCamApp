<script setup lang="ts">
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faGripLines, faChevronUp } from "@fortawesome/free-solid-svg-icons";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
const props = defineProps<{
  modelValue?: number;
  toggle?: boolean;
}>();
const emit = defineEmits<{
  (e: "update:modelValue", value: number): void;
}>();
const internal_height = ref<number>(props.modelValue || window.innerHeight / 3);
watch(
  () => props.modelValue,
  (val) => {
    if (val && val !== internal_height.value) internal_height.value = val;
  },
);
const drawer = ref<HTMLDivElement | null>(null);
const toggle = ref(props.toggle);

function toggleDrawer(e: KeyboardEvent) {
  if (e.key === "`" && e.ctrlKey) {
    e.preventDefault();
    toggle.value = !toggle.value;
  }
}

onMounted(() => window.addEventListener("keydown", toggleDrawer));
onUnmounted(() => window.removeEventListener("keydown", toggleDrawer));

function px(value: number | string) {
  if (typeof value === "number") return `${value}px`;
  return value;
}

const height = computed(() => {
  if (!toggle.value) return "0";
  return internal_height.value !== null
    ? px(internal_height.value)
    : px(props.modelValue ?? "50%");
});

watch(
  () => ({ h: internal_height.value, t: toggle.value }),
  ({ h, t }) => emit("update:modelValue", t ? (h ?? 0) : 0),
  { immediate: true },
);

type Pos = { x: number; y: number };

class DragContext {
  pos: Pos;
  is_drag: boolean;
  constructor(
    public readonly start: MouseEvent,
    public readonly delta: number | null = null,
  ) {
    this.pos = start;
    this.is_drag = delta === null ? true : false;
  }
  update(pos: MouseEvent) {
    const prev_pos = this.pos;
    this.pos = pos;
    if (!this.is_drag) {
      const dist = Math.sqrt(
        (this.start.x - pos.x) ** 2 + (this.start.y - pos.y) ** 2,
      );
      if (dist > (this.delta ?? 0)) this.is_drag = true;
    }
    if (this.is_drag) {
      return {
        x: pos.x - prev_pos.x,
        y: pos.y - prev_pos.y,
      };
    } else {
      return {
        x: 0,
        y: 0,
      };
    }
  }
}

const drag = ref<DragContext | null>(null);
function trackUntilRelease(e: MouseEvent) {
  if (!drag.value) return untrack();
  if (!(e.buttons & 1)) {
    if (!drag.value?.is_drag) toggle.value = false;
    return untrack();
  }
  // Compute position
  const el = drawer.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const delta = drag.value?.update(e).y ?? 0;
  const height = (internal_height.value ?? rect.height) - delta;
  if (height < 50) {
    toggle.value = false;
    return untrack();
  }
  internal_height.value = height;
}

function untrack() {
  drag.value = null;
  window.removeEventListener("mousemove", trackUntilRelease);
  window.removeEventListener("mouseup", trackUntilRelease);
}

function track(e: MouseEvent) {
  if (!(e.buttons & 1)) return;
  if (drag.value) return;
  drag.value = new DragContext(e, 5);
  window.addEventListener("mousemove", trackUntilRelease);
  window.addEventListener("mouseup", trackUntilRelease);
}
</script>

<template>
  <div class="drawer" ref="drawer" :style="{ height }">
    <div
      class="on-top edge-button"
      v-if="toggle === false"
      @click="toggle = true"
    >
      <Icon :icon="faChevronUp"></Icon>
    </div>
    <div class="on-top grab-area" v-else @mousedown="track">
      <Icon :icon="faGripLines"></Icon>
    </div>
    <div
      style="
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 10px;
        overflow: hidden;
      "
    >
      <slot v-if="toggle"></slot>
    </div>
  </div>
</template>

<style scoped lang="scss">
.drawer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  overflow: visible;
  background-color: var(--shadow);
  backdrop-filter: blur(4px);
  .on-top {
    position: absolute;
    left: 50%;
    transform: translateX(-50%) translateY(-100%);
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: nowrap;
    overflow: hidden;
  }
  .edge-button {
    transition: 0.1s;
    cursor: pointer;
    width: 8em;
    height: 1.6em;
    background-color: var(--bg-app);
    border-radius: 0.5em 0.5em 0 0;
    border: 2px solid var(--accent-bright);
    border-bottom: none;
    &:not(:hover):not(:active) {
      opacity: 0.2;
      background-color: var(--tint-2);
      filter: grayscale(1);
    }
  }
  .grab-area {
    cursor: ns-resize;
    backdrop-filter: blur(8px);
    width: 100%;
    height: 1em;
    /* translucent surface wash (kept literal — alpha on --bg-app) */
    background-color: #2228;
    border-top: 0.5px solid var(--tint-8);
    border-bottom: 0.5px solid var(--tint-8);
  }
}
</style>
