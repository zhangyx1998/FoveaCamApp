<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Capture-preview window body (capture-recorder-nodes.md ruling 8): the capture
  previews + SaveControls/SaveReport, lifted out of the retired title-bar
  overlay (`src/capture/index.vue`) into a `debug`-class window
  (`kind: "capture"`) the camera icon toggles. Mounted full-window by
  DebugWindow, which supplies the TitleBar.

  It connects its OWN passive `manual-control` session (the debugger pattern) —
  the app window keeps the session active/leased; this window only reads the
  server-held capture resources and forwards save. `current_capture` is a
  per-window global, so constructing a `Capture` facade here does not collide
  with the app window's.
-->
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useSession } from "@lib/orchestrator/client";
import { isEmpty } from "@lib/util";
import type { FramePayload } from "@lib/orchestrator/protocol";
import { manualControl } from "./contract";
import Capture from "@src/capture";
import SaveControls from "@src/capture/SaveControls.vue";
import SaveReport from "@src/capture/SaveReport.vue";
import PreviewMeta from "@src/capture/preview-meta/index.vue";
import PreviewImage from "@src/capture/preview-image/index.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";

const session = useSession(manualControl, "manual-control");

// The renderer-side save-path/save facade (SavePath UI + current_capture
// registration). Capture DRIVING lives in the app window (manual-control's
// Capture / Raster Capture buttons) — this window is a passive VIEWER that
// pulls the node's held resources.
const cap = new Capture(session, "manual-control");

// ── DATA-SOURCE SEAM (capture-node wave, Phase 3 ruling 7) ─────────────────
// Preview = the capture node's ACTUAL held resources (ruling 7): the resource
// list + metadata ride `telemetry.capture_meta` (the node's manifest, computed
// on the server), and each IMAGE is PULLED on demand via the `getPreview`
// command (the node downconverts its real full-depth resource to 8-bit BGRA).
// No republished preview frame stream. Re-pulled whenever a capture/raster run
// republishes `capture_meta`.
function* entries() {
  const meta = session.telemetry.capture_meta;
  for (const name of Object.keys(meta)) yield { name, meta: meta[name] as any };
}

const hasMeta = (m: unknown): boolean =>
  Array.isArray(m) ? m.some((x) => !isEmpty(x)) : !isEmpty(m);
const meta_entries = computed(() =>
  [...entries()]
    .filter(({ meta }) => hasMeta(meta))
    .map(({ name, meta }) => [name, meta] as const),
);

// Pulled previews, keyed by resource name (an array for a raster/indexed
// resource, a single payload otherwise). Repopulated on every `capture_meta`
// change by querying the node — the byte-source of what will be saved.
type Preview = FramePayload | null;
const previews = shallowRef<Record<string, Preview | Preview[]>>({});

async function refreshPreviews(): Promise<void> {
  const meta = session.telemetry.capture_meta;
  const next: Record<string, Preview | Preview[]> = {};
  await Promise.all(
    Object.keys(meta).map(async (name) => {
      const m = meta[name];
      if (Array.isArray(m)) {
        next[name] = await Promise.all(
          m.map((_, i) => cap.getPreview(name, i)),
        );
      } else {
        next[name] = await cap.getPreview(name);
      }
    }),
  );
  previews.value = next;
}
watch(() => session.telemetry.capture_meta, () => void refreshPreviews(), {
  deep: true,
  immediate: true,
});

const image_entries = computed(() =>
  [...entries()]
    .map(({ name }) => [name, previews.value[name] ?? null] as const)
    .filter(([, image]) => !isEmpty(image))
    .toReversed(),
);
// ── END DATA-SOURCE SEAM ───────────────────────────────────────────────────

const data_ready = computed(() => Object.keys(session.telemetry.capture_meta).length > 0);

const save_state = ref<Promise<void> | null>(null);

// Closing the window = the old overlay's "exit" (server holds the resources
// until the next save/discard/run, unchanged).
function close() {
  window.close();
}

function save(path: string, img_format: string) {
  if (save_state.value !== null) return;
  const p = cap.save(path, img_format);
  save_state.value = p;
  p.then(() => close());
}
</script>

<template>
  <div class="container">
    <SaveControls
      style="height: 4rem"
      :capture="cap"
      @save="save"
      @exit="close"
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
    <SaveReport v-else :state="save_state" @exit="close" />
  </div>
</template>

<style scoped lang="scss">
.container {
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
  background-color: #111;
  .content {
    position: absolute;
    top: 4rem;
    left: 0;
    right: 0;
    bottom: 0;
  }
  .run-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
    .message {
      color: #f56;
      font-size: 1.2rem;
      max-width: 60ch;
      text-align: center;
    }
    .actions {
      display: flex;
      gap: 1rem;
      button {
        padding: 0.4rem 1.6rem;
        font-size: 1rem;
        cursor: pointer;
      }
    }
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
