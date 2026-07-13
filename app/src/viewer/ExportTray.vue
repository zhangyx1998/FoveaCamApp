<script setup lang="ts">
// Title-bar EXPORT PROGRESS tray (viewer-export.md spec 9). Shows OVERALL
// progress across active exports; hover expands to a per-stream status report
// (name, %, fps/eta, state). Follows the title bar's icon-button language.
// Layout-stable + instant (no slide) per the ruled interaction principles.
import { computed } from "vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faFilm, faXmark } from "../windows/icons";
import type { ExportOverview } from "./export/types";

const props = defineProps<{
  overview: ExportOverview;
  /** A live capture session is running — the report shows a one-line note
   *  (addendum); no behavioral change to exports. */
  sessionActive: boolean;
}>();

const emit = defineEmits<{ (e: "abort", id: number): void; (e: "clear"): void }>();

const active = computed(() => props.overview.active);
/** Any terminal (done/failed/aborted) job — gates the "Clear finished"
 *  affordance so results never pin the tray with no exit. */
const hasFinished = computed(() =>
  props.overview.jobs.some((j) => j.state !== "running" && j.state !== "queued"),
);
const overallPct = computed(() =>
  props.overview.overall == null ? null : Math.round(props.overview.overall * 100),
);

function pct(p: number | null): string {
  return p == null ? "—" : `${Math.round(p * 100)}%`;
}
function eta(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  if (sec < 60) return `${Math.ceil(sec)}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${Math.ceil(sec % 60)}s`;
}
const STATE_LABEL: Record<string, string> = {
  queued: "queued",
  running: "running",
  done: "done",
  failed: "failed",
  aborted: "aborted",
};
</script>

<template>
  <div class="tray" v-if="overview.jobs.length > 0">
    <button class="icon-button trigger" :class="{ active: active > 0 }" title="Exports">
      <Icon :icon="faFilm" />
      <span v-if="active > 0" class="badge">{{ active }}</span>
      <span v-if="overallPct != null" class="pct">{{ overallPct }}%</span>
    </button>

    <!-- Hover report: instant, no animation; anchored below the trigger. -->
    <div class="report">
      <div class="report-head">
        Exports
        <span v-if="active > 0" class="count">· {{ active }} active</span>
        <button v-if="hasFinished" class="clear" title="Remove finished exports from this list" @click="emit('clear')">
          Clear finished
        </button>
      </div>
      <div v-if="sessionActive" class="note">
        A live capture session is running — exports may be slower.
      </div>
      <ul class="jobs">
        <li v-for="j in overview.jobs" :key="j.id" class="job" :class="j.state">
          <div class="job-line">
            <span class="dot" :class="j.state" />
            <span class="name" :title="j.channel">{{ j.name }}</span>
            <span class="state">{{ STATE_LABEL[j.state] }}</span>
            <button
              v-if="j.state === 'running' || j.state === 'queued'"
              class="abort"
              title="Abort export"
              @click="emit('abort', j.id)"
            >
              <Icon :icon="faXmark" />
            </button>
          </div>
          <div class="bar" v-if="j.state === 'running' || j.state === 'queued'">
            <div class="fill" :style="{ width: (j.progress != null ? j.progress * 100 : 0) + '%' }" />
          </div>
          <div class="sub">
            <span v-if="j.state === 'running'">{{ pct(j.progress) }} · {{ Math.round(j.fps) }} fps<span v-if="eta(j.etaSec)"> · {{ eta(j.etaSec) }} left</span></span>
            <span v-else-if="j.state === 'failed'" class="err" :title="j.error">{{ j.error || "failed" }}</span>
            <span v-else-if="j.state === 'done'">complete</span>
            <span v-else-if="j.state === 'aborted'">aborted</span>
            <span v-else>waiting…</span>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped lang="scss">
.tray {
  position: relative;
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
  &:hover .report { display: block; }
}
.trigger {
  display: flex;
  align-items: center;
  gap: 0.4ch;
  position: relative;
  &.active { color: var(--accent-bright); }
  .badge {
    background: var(--accent);
    color: white;
    border-radius: 1ch;
    padding: 0 0.5ch;
    font-size: 0.7em;
    line-height: 1.4;
  }
  .pct { font-size: 0.75em; color: var(--text-muted); }
}
.report {
  display: none;
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 0.3rem;
  width: 20rem;
  max-width: 90vw;
  // One floating-panel language with the stats popover (elevated surface, 6px
  // radius, matching shadow) — UI/UX review 2026-07-10.
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  box-shadow: 0 6px 22px var(--shadow);
  padding: 0.6rem 0.7rem;
  z-index: 40;
  color: var(--text);
  cursor: default;
}
.report-head {
  display: flex;
  align-items: baseline;
  gap: 0.5ch;
  font-weight: 600;
  margin-bottom: 0.4rem;
  .count { color: var(--text-muted); font-weight: 400; }
  .clear {
    margin-left: auto;
    background: transparent;
    border: none;
    color: var(--accent-bright);
    cursor: pointer;
    font-size: var(--fs-sm);
    font-weight: 400;
    padding: 0 0.4ch;
    border-radius: 0.3ch;
    &:hover { background: var(--tint-2); }
    &:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  }
}
.note {
  color: var(--warn);
  font-size: var(--fs-sm);
  margin-bottom: 0.5rem;
}
.jobs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.55rem; }
.job-line {
  display: flex;
  align-items: center;
  gap: 0.6ch;
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-sm); }
  .state { color: var(--text-faint); font-size: var(--fs-sm); }
  .abort {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0 0.2ch;
    border-radius: 0.3ch;
    &:hover { color: var(--danger-text); background: var(--tint-2); }
    &:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  }
}
.dot {
  width: 0.7ch;
  height: 0.7ch;
  border-radius: 50%;
  background: var(--text-faint);
  flex: 0 0 auto;
  &.running { background: var(--accent-bright); }
  &.done { background: var(--ok); }
  &.failed { background: var(--danger); }
  &.aborted { background: var(--text-disabled); }
  &.queued { background: var(--warn); }
}
.bar {
  height: 3px;
  background: var(--bg-panel-alt);
  border-radius: 2px;
  overflow: hidden;
  margin: 0.2rem 0;
  .fill { height: 100%; background: var(--accent); }
}
.sub {
  font-size: var(--fs-sm);
  color: var(--text-muted);
  .err { color: var(--danger-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; max-width: 100%; }
}
</style>
