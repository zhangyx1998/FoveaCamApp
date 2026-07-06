<script setup lang="ts">
import type { Mat } from "core/Vision";
import type { Size, Point } from "core/Geometry";
import { computed, ref, watch } from "vue";

import { FreqMeter, inspectorMode, RollingAverage } from "@lib/util/perf";
import FrameView, { TransformFunction } from "./FrameView.vue";
import { payloadToMat, rendererLoopLag } from "@lib/orchestrator/client";
import type { FramePayload } from "@lib/orchestrator/protocol";
import { Delegation } from "@src/capture";
import { NoCheck } from "@lib/util/vue";

// Payload-only (docs/refactor/orchestrator.md §7.1 S1c): every camera/stream
// now lives orchestrator-side, so the renderer only ever displays a
// `session.frame(...)` ref — the old direct-`Camera`/raw-`Frame` stream mode
// this component also used to support has no remaining callers (grep-
// verified across the whole tree before removal) and is deleted rather than
// kept dead.

const emit = defineEmits<{
  (
    e: "update:modelValue",
    event: (Point & Size & { buttons: number }) | null,
  ): void;
  (e: "mouse", event: (Point & Size & { buttons: number }) | null): void;
}>();

const props = defineProps({
  title: {
    type: String,
    required: false,
    default: null,
  },
  footnote: {
    type: String,
    required: false,
    default: null,
  },
  // Orchestrator frame source: bind a `session.frame(...)` ref.
  payload: {
    type: NoCheck<FramePayload | null | undefined>(),
    required: false,
    default: undefined,
  },
  transform: {
    type: NoCheck<TransformFunction | undefined>(),
    required: false,
    default: undefined,
  },
  overlay: {
    type: Object as () => Record<string, string>,
    required: false,
    default: {},
  },
  theme: {
    type: String,
    required: false,
    default: "gray",
  },
  width: {
    type: String,
    required: false,
    default: null,
  },
  height: {
    type: String,
    required: false,
    default: null,
  },
  capture: {
    // Delegation is a function, not an object; Vue runtime type check needs Function
    type: NoCheck<Delegation | string | null>(),
    required: false,
    default: null,
  },
  // Force the transport-profiling OSD lines on for this instance regardless
  // of the global toggle (Ctrl+Shift+I, `inspectorMode`).
  inspector: {
    type: Boolean,
    required: false,
    default: false,
  },
});

const mat = ref<Mat | null>(null);
const fps = new FreqMeter();
const inspectorOn = computed(() => props.inspector || inspectorMode.value);

// Profiling meters, fed from `FramePayload.meta` (docs/refactor/
// orchestrator.md roadmap item 3). `seq`/timestamps arrive only when the
// producer/transport stamped them, so every reading here degrades gracefully
// to "no data yet" rather than throwing.
let prevSeq: number | null = null;
let prevCaptureRef: number | null = null;
const sourceFreq = new FreqMeter(); // inferred production rate (received seq gaps)
const coalesce = new RollingAverage(0.9, 2, "x"); // avg seq delta between deliveries
const ipcLatency = new RollingAverage(0.7, 1, "ms"); // tReceive - tPublish
const frameAge = new RollingAverage(0.7, 1, "ms"); // tDisplay - tCapture

watch(
  () => props.payload,
  (p) => {
    if (!p) return;
    mat.value = payloadToMat(p);
    fps.tick();
    const m = p.meta;
    if (!m) return;
    const captureRef = m.tCapture ?? m.tPublish;
    if (m.seq !== undefined) {
      if (prevSeq !== null) {
        const deltaSeq = Math.max(1, m.seq - prevSeq);
        coalesce.roll(deltaSeq);
        if (captureRef !== undefined && prevCaptureRef !== null)
          sourceFreq.roll((captureRef - prevCaptureRef) / deltaSeq);
      }
      prevSeq = m.seq;
    }
    if (captureRef !== undefined) prevCaptureRef = captureRef;
    if (m.tReceive !== undefined && m.tPublish !== undefined)
      ipcLatency.roll(m.tReceive - m.tPublish);
    if (m.tDisplay !== undefined && m.tCapture !== undefined)
      frameAge.roll(m.tDisplay - m.tCapture);
  },
  { immediate: true },
);

const overlay = computed(() => {
  const result: Record<string, string> = { ...(props.overlay ?? {}) };
  const p = props.payload;
  if (p) {
    result["Resolution"] = `${p.shape[1]} × ${p.shape[0]}`;
    if (inspectorOn.value && p.meta) {
      const m = p.meta;
      result["Seq"] = m.seq !== undefined ? String(m.seq) : "-";
      result["Source Rate"] = sourceFreq.toString();
      result["Coalesce"] = `${coalesce.value.toFixed(2)}x`;
      if (m.convertMs !== undefined)
        result["Convert"] = `${m.convertMs.toFixed(2)} ms`;
      result["IPC Latency"] = ipcLatency.toString();
      result["Frame Age"] = frameAge.toString();
      if (p.shm) {
        result["SHM"] = `gen ${p.shm.gen} / retries ${p.shm.retries ?? 0}`;
      }
      result["Throughput"] =
        `${((fps.value * (p.data?.byteLength ?? 0)) / 1e6).toFixed(2)} MB/s`;
      // Renderer-side event-loop lag (perf substrate, §7.3 item 1) — a
      // module-level singleton (one probe, not one per StreamView), so
      // every inspector overlay shows the same renderer-wide number.
      result["Renderer Lag"] =
        `${rendererLoopLag.stats.mean.toFixed(2)} ms (max ${rendererLoopLag.stats.max.toFixed(2)})`;
    }
  }
  result["Frame Rate"] = fps.toString();
  return result;
});
</script>

<template>
  <FrameView
    :mat="mat"
    :transform="transform"
    :overlay="overlay"
    :title="title"
    :footnote="footnote"
    :theme="theme"
    :width="width"
    :height="height"
    :capture="capture"
    @update:modelValue="(e) => emit('update:modelValue', e)"
    @mouse="(e) => emit('mouse', e)"
  >
    <slot></slot>
  </FrameView>
</template>

<style scoped lang="scss">
.container {
  position: relative;
  background-color: black;
  background: repeating-linear-gradient(
    45deg,
    #111,
    #111 10px,
    #222 10px,
    #222 20px
  );
  overflow: visible;
  outline: 2px solid var(--theme, gray);

  .title {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    height: 2em;
    line-height: 2em;
    font-size: 0.8em;
    text-align: left;
    color: gray;
    user-select: none;
  }

  .footnote {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    height: 2em;
    line-height: 2em;
    font-size: 0.8em;
    text-align: left;
    color: gray;
    user-select: none;
  }

  &:hover .title {
    color: var(--theme, gray);
  }

  canvas {
    margin: 0;
  }

  .stream-info {
    flex-direction: column;
    justify-content: center;
    align-items: left;
    overflow-y: scroll;
  }

  &.no-stream {
    outline-color: #444 !important;
  }

  .no-stream-text {
    color: #444;
    justify-content: center;
    align-items: center;
    font-size: 2em;
  }

  & > .centered {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  &:not(:hover) {
    outline: none !important;
  }
}

:deep(.overlay) {
  background-color: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px) saturate(50%) brightness(80%);
  -webkit-backdrop-filter: blur(4px) saturate(50%) brightness(80%);
  color: white;
  font-family: "Cascadia Code", "Courier New", Courier, monospace;
  z-index: 10;
  white-space: pre;
}
</style>
