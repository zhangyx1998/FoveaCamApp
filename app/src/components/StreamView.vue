<script setup lang="ts">
import type { Mat } from "core/Vision";
import type { Size, Point } from "core/Geometry";
import { computed, onUnmounted, ref, watch } from "vue";

import { FreqMeter, inspectorMode, RollingAverage } from "@lib/util/perf";
import FrameView, { TransformFunction } from "./FrameView.vue";
import { payloadToMat, rendererLoopLag, shmReadStats, type StreamPayload } from "@lib/orchestrator/client";
import { formatCounterRate, formatSampleStats } from "@lib/orchestrator/stats";
import type { PaneDescriptor } from "@lib/projection/descriptor";
import { NoCheck } from "@lib/util/vue";

// Payload-only: every camera/stream lives orchestrator-side, so the renderer
// only ever displays a `session.frame(...)` ref.

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
  // Orchestrator frame payload: bind a `session.frame(...)` / `usePipeFrame(...)`
  // ref. Displayed payloads arrive with their client-stamped stream address
  // (`StreamPayload.source`), which alone drives the projection button —
  // no separate address prop to wire at call sites.
  payload: {
    type: NoCheck<StreamPayload | null | undefined>(),
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
  // Force the transport-profiling OSD lines on for this instance regardless
  // of the global toggle (Ctrl+Shift+I, `inspectorMode`).
  inspector: {
    type: Boolean,
    required: false,
    default: false,
  },
  // The project-to-window button opens a projection window for this stream;
  // the address rides the displayed payload itself.
  // Set `projectable` false to hide the button entirely (used by the projection
  // window itself, so it doesn't offer projecting a projection, and by debug
  // views whose SVG overlays would not ride along).
  projectable: {
    type: Boolean,
    required: false,
    default: true,
  },
});

const mat = ref<Mat | null>(null);
const fps = new FreqMeter();
const inspectorOn = computed(() => props.inspector || inspectorMode.value);

// Staleness detection: the meters only update on a payload change, so a dead
// stream would otherwise show the last
// frame and its last healthy FPS forever. A 1 Hz ticker feeds the overlay
// `computed` an independent clock so it can render a STALLED badge once the gap
// since the last frame exceeds a threshold scaled to the recent rate.
let lastFrameAt = 0;
const now = ref(Date.now());
const staleTimer = setInterval(() => (now.value = Date.now()), 1000);
onUnmounted(() => clearInterval(staleTimer));

// Seconds the stream has been stalled, or null when live. The threshold scales
// to the recent rate (a 60 Hz stream is "stalled" far sooner than a 2 Hz one),
// floored at 1.5 s so a genuinely slow stream never false-positives.
const stallSeconds = computed<number | null>(() => {
  if (!props.payload || !lastFrameAt) return null;
  const since = now.value - lastFrameAt;
  const hz = fps.value;
  const threshold = Math.max(1500, (hz > 0 ? 1000 / hz : 0) * 5);
  return since > threshold ? since / 1000 : null;
});

// Profiling meters, fed from `FramePayload.meta`. `seq`/timestamps arrive only
// when the
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
    lastFrameAt = Date.now();
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
        // Renderer transfer-pool health — module-wide singleton, so
        // every SHM inspector overlay shows the same pool counters.
        const s = shmReadStats();
        result["SHM Reads"] =
          `${formatCounterRate(s.rates.reads)} ok / ${formatCounterRate(s.rates.nulls)} null / ` +
          `${formatCounterRate(s.rates.timeouts)} to / ${formatCounterRate(s.rates.errors)} err`;
        result["SHM Pool"] =
          `${formatCounterRate(s.rates.poolHits)} reuse / ${formatCounterRate(s.rates.allocations)} alloc / ` +
          `${s.inFlight} inflight`;
        result["SHM Read Lat"] = formatSampleStats(s.latencyMs);
      }
      result["Throughput"] =
        `${((fps.value * (p.data?.byteLength ?? 0)) / 1e6).toFixed(2)} MB/s`;
      // Renderer-side event-loop lag (perf substrate) — a
      // module-level singleton (one probe, not one per StreamView), so
      // every inspector overlay shows the same renderer-wide number.
      result["Renderer Lag"] =
        `${rendererLoopLag.stats.mean.toFixed(2)} ms (max ${rendererLoopLag.stats.max.toFixed(2)})`;
    }
  }
  // Stall badge: reuse the Frame Rate row (layout stability — no new row to
  // shift neighbors) so a frozen stream reads "STALLED n.n s" instead of a stale,
  // healthy-looking FPS.
  const stalled = stallSeconds.value;
  result["Frame Rate"] =
    stalled !== null ? `STALLED ${stalled.toFixed(1)} s` : fps.toString();
  return result;
});

// Projectable pane descriptor for the project-to-window button — implicit: the
// displayed payload carries its client-stamped stream address, so any
// frame- or pipe-backed view is projectable with no extra wiring. Null (no
// frame yet / no address / `projectable` false) keeps only the fullscreen icon.
// The address is RETAINED past a payload null (pipe close nulls the payload but
// `mat` keeps showing the last frame): the affordance must live exactly as long
// as the pixels; a rebind's first frame re-stamps it.
const lastSource = ref<StreamPayload["source"]>(undefined);
watch(
  () => props.payload?.source,
  (s) => {
    if (s) lastSource.value = s;
  },
  { immediate: true },
);
const projection = computed<PaneDescriptor | null>(() => {
  if (!props.projectable) return null;
  const source = props.payload?.source ?? lastSource.value;
  if (!source) return null;
  return {
    source,
    title: props.title ?? undefined,
    theme: props.theme !== "gray" ? props.theme : undefined,
  };
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
    :projection="projection"
    @update:modelValue="(e) => emit('update:modelValue', e)"
    @mouse="(e) => emit('mouse', e)"
  >
    <!-- Forward EVERY slot the caller passed (default + named, e.g. #title)
         to FrameView. `#[name]` with name === "default" reaches FrameView's
         unnamed <slot>, so the default renders exactly once in its original
         position; only slots actually passed are forwarded, so untitled
         StreamViews are unchanged. -->
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </FrameView>
</template>

<style scoped lang="scss">
.container {
  position: relative;
  background-color: var(--bg-canvas);
  background: repeating-linear-gradient(
    45deg,
    var(--bg-chrome),
    var(--bg-chrome) 10px,
    var(--bg-app) 10px,
    var(--bg-app) 20px
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
    outline-color: var(--border-strong) !important;
  }

  .no-stream-text {
    color: var(--border-strong);
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
  color: var(--text);
  font-family: var(--font-mono);
  z-index: 10;
  white-space: pre;
}
</style>
