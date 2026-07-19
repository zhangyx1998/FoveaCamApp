<script setup lang="ts">
// Per-stream VIDEO-EXPORT dialog. A proper modal
// consistent with the viewer's existing modal pattern; every option reads the
// pure codec table (`export/codecs`) so the UI can never offer a combination the
// ffmpeg-arg builder can't produce. Disabled controls always carry a WHY hint
// (design tokens, instant/snap/layout-stable).
import { computed, ref, watch } from "vue";
import {
  CODECS,
  pixfmtsFor,
  defaultPixfmtFor,
  alphaSupported,
  containerFor,
  defaultExportBasename,
  codec as codecSpec,
  type CodecId,
} from "./export/codecs";
import type { ExportRequest, NormalizeMode } from "./export/types";

const props = defineProps<{
  /** Frame channel topic being exported. */
  channel: string;
  /** Recording basename (no extension) for the default filename. */
  recording: string;
  /** Source frame width/height (px) — shown + carried for validation. */
  width: number;
  height: number;
  /** Detected default fps (median-ish; overridable). */
  defaultFps: number;
  /** ffmpeg resolved by the engine — else the whole dialog shows the hint. */
  ffmpegAvailable: boolean;
  /** Undistort offerable: calibration present AND this is the wide/center
   *  stream. When false the toggle is disabled with `undistortReason`. */
  undistortAvailable: boolean;
  /** Why undistort is unavailable (shown when disabled). */
  undistortReason: string;
  /** Global parallel-export policy (persisted). */
  parallel: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "submit", request: ExportRequest): void;
  (e: "set-parallel", value: boolean): void;
}>();

const codec = ref<CodecId>("x264");
const profile = ref<string>("422");
const pixfmt = ref<string>("yuv420p");
const fps = ref<number>(Math.max(1, Math.round(props.defaultFps) || 30));
const normalize = ref<NormalizeMode>("as-is");
const undistort = ref<boolean>(props.undistortAvailable); // DEFAULT applied
const alpha = ref<boolean>(true); // DEFAULT enabled (gated below)
const busy = ref(false);

const spec = computed(() => codecSpec(codec.value));
const isProRes = computed(() => codec.value === "prores");
const pixfmtOptions = computed(() => pixfmtsFor(codec.value, profile.value));

// Codec change → reset profile + pixfmt to that codec's defaults (layout-stable,
// instant). ProRes profile change → reset pixfmt (422/HQ vs 4444 alpha).
watch(codec, (c) => {
  const s = codecSpec(c);
  profile.value = s.defaultProfile ?? "422";
  pixfmt.value = defaultPixfmtFor(c, profile.value);
});
watch(profile, (p) => {
  if (isProRes.value) pixfmt.value = defaultPixfmtFor("prores", p);
});

// Alpha is only meaningful when the pixfmt supports it AND undistort is on (OOB
// remap regions are what alpha reveals). Otherwise it's forced off with
// a reason.
const pixfmtHasAlpha = computed(() => alphaSupported(codec.value, pixfmt.value));
const alphaEnabled = computed(() => pixfmtHasAlpha.value && undistort.value);
const alphaReason = computed(() => {
  if (!pixfmtHasAlpha.value) return "The selected format/pixel format has no alpha channel";
  if (!undistort.value) return "Transparency only reveals undistort out-of-bounds regions — enable Undistort";
  return "";
});
// Keep the alpha checkbox visually consistent when it can't apply.
const effectiveAlpha = computed(() => alphaEnabled.value && alpha.value);

const container = computed(() => containerFor(codec.value));
const outName = computed(
  () => `${defaultExportBasename(props.recording, props.channel)}.${container.value}`,
);

const fpsValid = computed(() => Number.isFinite(fps.value) && fps.value > 0);

async function confirm(): Promise<void> {
  if (!props.ffmpegAvailable || !fpsValid.value || busy.value) return;
  busy.value = true;
  try {
    const path = await window.foveaBridge?.showExportSaveDialog?.(
      defaultExportBasename(props.recording, props.channel),
      container.value,
    );
    if (!path) return; // cancelled
    const request: ExportRequest = {
      channel: props.channel,
      codec: codec.value,
      pixfmt: pixfmt.value,
      ...(isProRes.value ? { profile: profile.value } : {}),
      fps: fps.value,
      normalize: normalize.value,
      undistort: undistort.value && props.undistortAvailable,
      alpha: effectiveAlpha.value,
      outputPath: path,
    };
    emit("submit", request);
    emit("close");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-scrim" @pointerdown.self="emit('close')">
    <div class="modal export-modal" role="dialog" aria-label="Export video">
      <header class="head">
        <span class="title">Export video</span>
        <span class="stream">{{ channel }}</span>
      </header>

      <div v-if="!ffmpegAvailable" class="missing">
        <strong>ffmpeg not found.</strong>
        Install ffmpeg (e.g. <code>brew install ffmpeg</code>) and reopen this
        recording to enable video export.
      </div>

      <div v-else class="body">
        <label class="field">
          <span class="lbl">Format</span>
          <select v-model="codec">
            <option v-for="c in CODECS" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select>
        </label>

        <label v-if="isProRes" class="field">
          <span class="lbl">Profile</span>
          <select v-model="profile">
            <option v-for="p in spec.profiles" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select>
        </label>

        <label class="field">
          <span class="lbl">Pixel format</span>
          <select v-model="pixfmt">
            <option v-for="p in pixfmtOptions" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select>
        </label>

        <label class="field">
          <span class="lbl">Frame rate</span>
          <span class="fps">
            <input type="number" min="1" step="1" v-model.number="fps" :class="{ invalid: !fpsValid }" />
            <span class="unit">fps</span>
            <!-- Disabled when nothing was detected — the reset must never jump
                 to an arbitrary value the label doesn't show. -->
            <button
              type="button"
              class="link"
              title="Reset to detected"
              :disabled="!Math.round(defaultFps)"
              @click="fps = Math.max(1, Math.round(defaultFps))"
            >
              detected {{ Math.round(defaultFps) || "—" }}
            </button>
          </span>
        </label>

        <label class="field">
          <span class="lbl">Timing</span>
          <select v-model="normalize">
            <option value="as-is">As-is (aligned frames)</option>
            <option value="resample">More accurate (resample + blend)</option>
          </select>
        </label>

        <div class="field toggle" :class="{ disabled: !undistortAvailable }">
          <span class="lbl">Undistort</span>
          <label class="chk" :title="undistortAvailable ? '' : undistortReason">
            <input type="checkbox" v-model="undistort" :disabled="!undistortAvailable" />
            <span>Correct lens distortion</span>
          </label>
          <span v-if="!undistortAvailable" class="hint">{{ undistortReason }}</span>
        </div>

        <div class="field toggle" :class="{ disabled: !alphaEnabled }">
          <span class="lbl">Transparency</span>
          <label class="chk" :title="alphaEnabled ? '' : alphaReason">
            <!-- Shows the EFFECTIVE state: a disabled checkbox must never read
                 "checked" while alpha is off. The user's intent (`alpha`)
                 survives a codec round-trip, so re-enabling restores the
                 checkmark. -->
            <input
              type="checkbox"
              :checked="effectiveAlpha"
              :disabled="!alphaEnabled"
              @change="alpha = ($event.target as HTMLInputElement).checked"
            />
            <span>Out-of-bounds regions transparent</span>
          </label>
          <span v-if="!alphaEnabled" class="hint">{{ alphaReason }}</span>
        </div>

        <div class="field toggle">
          <span class="lbl">Queue</span>
          <label class="chk" title="Run multiple exports at once instead of one after another">
            <input
              type="checkbox"
              :checked="parallel"
              @change="emit('set-parallel', ($event.target as HTMLInputElement).checked)"
            />
            <span>Run exports in parallel <em class="global-note">(applies to all exports)</em></span>
          </label>
        </div>

        <div class="field meta">
          <span class="lbl">Output</span>
          <span class="out">{{ width }}×{{ height }} · <code>{{ outName }}</code></span>
        </div>
      </div>

      <footer class="actions">
        <button class="ghost" @click="emit('close')">Cancel</button>
        <button
          class="primary"
          :disabled="!ffmpegAvailable || !fpsValid || busy"
          @click="confirm"
        >
          {{ busy ? "…" : "Export…" }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped lang="scss">
// Unified with the viewer's confirm-dialog shell (ViewerWindow `.modal-scrim`/
// `.modal`): same scrim + z-index 100 + surface tokens so the two never read as
// different modal languages. The export form keeps its wider form factor via
// `.export-modal`.
.modal-scrim {
  position: fixed;
  inset: 0;
  background: #000a;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: var(--bg-panel-alt);
  border: 1px solid var(--tint-3);
  border-radius: 8px;
  box-shadow: 0 8px 32px var(--shadow);
  color: var(--text);
  font-size: var(--fs-base);
}
.export-modal {
  width: 30rem;
  max-width: 92vw;
  max-height: 90vh;
  overflow: auto;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  padding: 0.9rem 1.1rem;
  border-bottom: 1px solid var(--border);
  .title { font-weight: 600; }
  .stream { color: var(--text-muted); font-family: var(--font-mono); font-size: var(--fs-sm); }
}
.missing {
  padding: 1.1rem;
  color: var(--text-dim);
  code { font-family: var(--font-mono); color: var(--text-bright); }
}
.body {
  padding: 0.8rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.field {
  display: grid;
  grid-template-columns: 8rem 1fr;
  align-items: center;
  gap: 0.6rem;
  .lbl { color: var(--text-muted); }
  select,
  input[type="number"] {
    // Recessed against the panel-alt modal surface (kept darker for contrast
    // after the shell unified onto the confirm-modal tokens).
    background: var(--bg-chrome);
    color: var(--text);
    border: 1px solid var(--border-muted);
    border-radius: 0.3ch;
    padding: 0.25rem 0.4rem;
    font-size: var(--fs-base);
  }
  input.invalid { border-color: var(--danger-strong); }
}
.fps {
  display: flex;
  align-items: center;
  gap: 0.5ch;
  input { width: 5rem; }
  .unit { color: var(--text-faint); }
  .link {
    background: none;
    border: none;
    color: var(--accent-bright);
    cursor: pointer;
    font-size: var(--fs-sm);
    padding: 0;
  }
}
.toggle {
  align-items: start;
  &.disabled .chk { color: var(--text-disabled); }
  .chk {
    display: flex;
    align-items: center;
    gap: 0.6ch;
    cursor: pointer;
  }
  .hint {
    grid-column: 2;
    color: var(--text-faint);
    font-size: var(--fs-sm);
    margin-top: 0.2rem;
  }
  .global-note {
    color: var(--text-faint);
    font-style: normal;
    font-size: var(--fs-sm);
  }
}
.meta .out {
  color: var(--text-dim);
  font-size: var(--fs-sm);
  code { font-family: var(--font-mono); color: var(--text-strong); }
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6ch;
  padding: 0.8rem 1.1rem;
  border-top: 1px solid var(--border);
  // No resting borders on inline buttons. The SECONDARY
  // (Cancel) button reads as a faint fill on hover; the PRIMARY action keeps its
  // solid accent fill (emphasis via fill, not a border). :focus-visible stays.
  button {
    padding: 0.35rem 0.9rem;
    border-radius: 0.3ch;
    cursor: pointer;
    font-size: var(--fs-base);
    border: none;
    background: transparent;
    &:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  }
  .ghost {
    color: var(--text-dim);
    &:hover { background: var(--tint-2); color: var(--text-bright); }
  }
  .primary {
    background: var(--accent);
    color: white;
    &:hover:not(:disabled) { background: var(--accent-bright); }
    &:disabled { opacity: 0.5; cursor: not-allowed; }
  }
}
</style>
