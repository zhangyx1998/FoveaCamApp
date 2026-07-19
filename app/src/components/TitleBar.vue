<script setup lang="ts">
// The shared window chrome: used by every window class (welcome / app /
// profiler). Fullscreen handling lives here —
// main forwards each window's `enter/leave-full-screen` via
// `foveaBridge.onFullscreenChange`, and the chrome adjusts the
// traffic-light inset + drag regions on BOTH transitions.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { overlay } from "./Overlay.vue";

const props = defineProps<{
  title: string;
  subtitle?: string | null;
  /** Opt-in: the title acts as a "back to home" button (app windows only).
   *  Default OFF — the title is then part of the draggable chrome, so the
   *  bar stays usable for OS window management. */
  homeButton?: boolean;
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
const fullscreen = ref(false);

// Base bar height when the Window Controls Overlay reports nothing usable.
const BASE_HEIGHT = 40;

// Keep the bar VISIBLE in full screen (VSCode-style). On macOS full screen
// `getTitlebarAreaRect()` reports `height: 0`, which `?? 40` would not catch
// (only null/undefined), collapsing the bar to 0px — so guard with
// `|| BASE_HEIGHT`. Full screen → fixed base height, full-width (no
// traffic-light reserve). Windowed → overlay height (`|| BASE_HEIGHT` so a
// transient 0 during the transition falls back) plus its top offset.
const height = computed(() =>
  fullscreen.value
    ? BASE_HEIGHT
    : (rect.value?.height || BASE_HEIGHT) + (rect.value?.top ?? 0),
);

watch(height, (h) => emit("height", h), { immediate: true });

// Traffic-light inset: zero while fullscreen (macOS hides the controls), the
// overlay rect's left edge otherwise. Derived from `fullscreen` explicitly —
// not just from the rect — so entering fullscreen can't leave a stale inset
// even if the overlay geometry callback lags the transition.
const leftInset = computed(() =>
  fullscreen.value ? 0 : (rect.value.left ?? 0),
);

function style(): Record<string, string> {
  // Full screen: fixed base height, full-width, no top reserve (same guard as
  // the `height` computed). Windowed: overlay geometry, with `|| BASE`
  // so a transient 0 during the transition doesn't collapse the bar.
  if (fullscreen.value) {
    return {
      height: BASE_HEIGHT + "px",
      paddingTop: "0px",
      fontSize: BASE_HEIGHT * 0.4 + "px",
    };
  }
  const { height: h = BASE_HEIGHT, top = 0 } = rect.value;
  const base = h || BASE_HEIGHT;
  return {
    height: base + top + "px",
    paddingTop: top + "px",
    fontSize: base * 0.4 + "px",
  };
}

function onResize() {
  rect.value = getRect();
}

// `resize` alone is insufficient: it fires DURING the fullscreen transition,
// when `getTitlebarAreaRect()` still reports transitional geometry, and nothing
// recomputes after it settles. Recompute on the overlay's own `geometrychange`
// event (the authoritative signal) AND on both forwarded fullscreen
// transitions, with settle-delayed retries for the macOS transition animation.
function refreshSoon() {
  onResize();
  requestAnimationFrame(onResize);
  setTimeout(onResize, 150);
  setTimeout(onResize, 500); // macOS fullscreen animation settles late
}

onMounted(() => {
  window.addEventListener("resize", onResize);
  (navigator as any).windowControlsOverlay?.addEventListener?.(
    "geometrychange",
    onResize,
  );
  window.foveaBridge?.onFullscreenChange?.((fs: boolean) => {
    fullscreen.value = fs;
    refreshSoon();
  });
});
onUnmounted(() => {
  window.removeEventListener("resize", onResize);
  (navigator as any).windowControlsOverlay?.removeEventListener?.(
    "geometrychange",
    onResize,
  );
});
</script>

<template>
  <div class="title-bar" :style="style()">
    <div class="draggable" :style="{ width: leftInset + 'px' }"></div>
    <div
      class="title"
      :class="props.homeButton ? 'home-button' : 'draggable'"
      @click="props.homeButton && emit('back-to-home')"
    >
      {{ title }}
    </div>
    <!-- The subtitle joins the draggable chrome. The class must sit on the
         real elements — a `<template>` renders nothing, so a class on it is
         silently dropped, which would leave the subtitle area non-draggable. -->
    <template v-if="subtitle">
      <div class="connector draggable">-</div>
      <div class="subtitle draggable">{{ subtitle }}</div>
    </template>
    <div class="draggable" style="width: 0; flex-grow: 1"></div>
    <!-- Actions slot: right-aligned window-level controls (record/capture in
         app windows, snapshot controls in the profiler). Explicitly no-drag
         so slotted buttons stay clickable while the bar remains draggable
         via the .draggable strips; empty slot = today's look. -->
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
  background-color: var(--bg-chrome);
  border-bottom: 1px solid var(--bg-app);
  flex-wrap: nowrap;
  overflow: visible;
  box-sizing: border-box;

  .draggable {
    -webkit-app-region: drag;
    height: 100%;
    margin: 0;
  }

  .title {
    color: var(--text);
    position: relative;
    padding: 0.2ch 0.8ch;
    border-radius: 0.4ch;

    // Non-home-button titles join the draggable chrome, but stay
    // content-sized — .draggable's height:100% is for the strip spacers and
    // would pin the label to the top of the bar.
    &.draggable {
      height: auto;
    }

    // Back-to-home affordance only when opted in (app windows). No hover
    // tooltip in any case; non-home-button titles are draggable chrome.
    &.home-button:hover {
      cursor: pointer;
      background-color: var(--border);
    }

    &.home-button:active {
      outline: 2px solid var(--accent);
    }
  }

  // Connector + subtitle are draggable chrome (system window drag). No
  // `pointer-events: none` on the connector — the app-region hit-test needs
  // events to land on the element. They keep .draggable's full bar height
  // (maximizes the grab area) and center their text vertically themselves.
  .connector {
    color: var(--text-faint);
    &.draggable {
      display: flex;
      align-items: center;
    }
  }

  .subtitle {
    color: var(--text-dim);
    padding: 0 0.5ch;
    &.draggable {
      display: flex;
      align-items: center;
    }
  }

  .slot {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 1ch;
    height: 100%;
    -webkit-app-region: no-drag;
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
