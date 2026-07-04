<script setup lang="ts">
import { current_capture } from ".";
import SaveControls from "./SaveControls.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";
import { computed, onMounted, ref } from "vue";
import PreviewMeta from "./preview-meta/index.vue";
import PreviewImage from "./preview-image/index.vue";
import { isEmpty } from "@lib/util";
import SaveReport from "./SaveReport.vue";

const emit = defineEmits(["exit"]);
const capture = current_capture.value;
if (isEmpty(capture))
  throw new Error("Overlay must be used within a Capture context");
// Re-bind to a fresh `const` so the non-null narrowing above survives into
// the function declarations below (TS doesn't narrow `capture` itself across
// a hoisted function boundary).
const cap = capture;

// Resource names present in this capture pass, in whatever order the server
// first reported them (`capture_meta` is a plain object, so this only needs
// to react to key-set changes — Vue's reactivity on `Object.keys` already
// does that for a reactive object).
function* entries() {
  const meta = cap.session.telemetry.capture_meta;
  for (const name of Object.keys(meta)) {
    const m = meta[name];
    if (!isEmpty(m)) yield { name, meta: m as any };
  }
}

const meta_entries = computed(() => [...entries()].map(({ name, meta }) => [name, meta] as const));

const image_entries = computed(() =>
  [...entries()]
    .map(({ name, meta }) => {
      // Frame channel(s) for this resource — indexed iff its meta is an
      // array (a multi-set-point capture), matching the server's exact
      // `capture:<name>` / `capture:<name>#<i>` naming (see `capture.ts`).
      const image = Array.isArray(meta)
        ? meta.map((_, i) => cap.session.frame(`capture:${name}#${i}`).value)
        : cap.session.frame(`capture:${name}`).value;
      return [name, image] as const;
    })
    .toReversed(),
);

// Note: the server-side capture isn't cancellable mid-flight (unlike the old
// renderer-local `abortable` provider chain) — closing the overlay before
// this resolves just stops watching; the pass still completes and its
// result sits server-side until the next save/discard/run.
const data_ready = ref(false);
onMounted(async () => {
  await capture.run();
  data_ready.value = true;
});

const save_state = ref<Promise<void> | null>(null);

function save(path: string, img_format: string) {
  if (save_state.value !== null) return;
  const p = cap.save(path, img_format);
  save_state.value = p;
  p.then(() => emit("exit"));
}
</script>

<template>
  <div class="container">
    <SaveControls
      style="height: 4rem"
      :capture="capture"
      @save="save"
      @exit="emit('exit')"
      :data_ready="data_ready"
      :save_state="save_state !== null"
    />
    <HorizontalDivision
      :division="0.2"
      class="content"
      v-if="save_state === null"
    >
      <template #left>
        <div class="meta-container">
          <PreviewMeta
            v-for="[name, meta] of meta_entries"
            :key="name"
            :name="name"
            :meta="meta"
          />
        </div>
      </template>
      <template #right>
        <div class="frame-container">
          <PreviewImage
            v-for="[name, image] of image_entries"
            :key="name"
            :name="name"
            :image="image"
          />
        </div>
      </template>
    </HorizontalDivision>
    <SaveReport v-else :state="save_state" @exit="emit('exit')" />
  </div>
</template>

<style scoped lang="scss">
.container {
  width: 100%;
  height: 100%;
  position: relative;
  background-color: #0008;
  backdrop-filter: blur(12px) brightness(0.8);
  .content {
    position: absolute;
    top: 4rem;
    left: 0;
    right: 0;
    bottom: 0;
  }
  .done {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2rem;
    font-weight: bold;
  }
}

.meta-container,
.frame-container {
  width: 100%;
  height: 100%;
}
.meta-container {
  overflow-x: hidden;
  overflow-y: scroll;
  padding: 0;
  & > * {
    width: 100%;
    margin: 0;
  }
}
.frame-container {
  padding: 2rem;
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: flex-start;
  align-items: flex-start;
  overflow-x: hidden;
  overflow-y: scroll;
  gap: 2rem;
  & > * {
    width: 20rem;
    height: 15rem;
    margin: 0 1rem;
  }
}
</style>
