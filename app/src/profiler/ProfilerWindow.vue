<!-- ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 --------------------------------------------------------- -->

<!-- The profiler window — read-only over existing telemetry. `system` is the
     always-on session; controller/manual-control are passive observers so
     opening the profiler never starts actuation loops or camera taps.
     spec: docs/spec/profiler-graph.md (per-instance binding: #binding) -->

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  useSession,
  rendererLoopLag,
  orchestratorSpans,
  dumpPerfSnapshot,
  orchestratorDown,
} from "@lib/orchestrator/client";
import { readUrlParam } from "@lib/url-state";
import { PROFILER_INSTANCE_PARAM, PROFILER_SESSION_PARAM } from "@lib/windows";
import { profilerSubtitle, describeSessionEnd } from "./binding";
import {
  system,
  controller,
  type PerfSnapshot,
  type Span,
} from "@lib/orchestrator/contracts";
import { manualControl } from "@modules/manual-control/contract";
import {
  workloadRows,
  utilizationLevel,
  UTILIZATION_HIGH,
  type WorkloadRow,
} from "./workload-view";
import { pipes } from "@lib/orchestrator/pipe-contract";
import type { GraphTopology } from "@lib/orchestrator/graph-contract";
import { deriveTopology, selectTopology } from "./graph-view";
import {
  REPORT_INTERVAL_KEY,
  REPORT_INTERVAL_OPTIONS,
  parseReportInterval,
} from "./graph-interactions";
import GraphPanel from "./GraphPanel.vue";
import Sparkline from "../components/Sparkline.vue";
import PosView from "@src/components/PosView.vue";
import TitleBar from "../components/TitleBar.vue";
import { overlay } from "../components/Overlay.vue";
import SnapshotOverlay, { snapshotResult } from "./SnapshotOverlay.vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faFileExport,
  faFolderOpen,
  faSpinner,
  faThumbtack,
} from "@fortawesome/free-solid-svg-icons";

// Shared window chrome (A-7): the profiler BrowserWindow now uses the same
// hidden-titlebar overlay as every other window class.
const titleBarHeight = ref(0);

// Per-instance binding (orchestrator-lifecycle-and-exit §"Profiler per-instance
// binding"): this window pinned AT OPEN to exactly one orchestrator instance —
// the ids ride the URL and are IMMUTABLE for the window's life. The connect
// broker (main) routes us to that instance and NOTHING else; when it dies we
// freeze here with everything already collected and never re-attach (ruling 2).
const boundInstanceId = readUrlParam(PROFILER_INSTANCE_PARAM);
const boundSession = readUrlParam(PROFILER_SESSION_PARAM);
const subtitle = computed(() =>
  profilerSubtitle(boundSession, boundInstanceId),
);

// Frozen "session ended/crashed" state: `orchestratorDown` is set once main
// pushes the typed down report for OUR instance (delivered whether it dies
// while we watch or was already dead when we connected — the broker replays
// it). Once set we stop polling entirely (no reconnect, no error spam) and keep
// the accumulated graphs/meters/clocks/spans browsable.
const sessionEnded = computed(() => orchestratorDown.value !== null);
const endState = computed(() =>
  orchestratorDown.value ? describeSessionEnd(orchestratorDown.value) : null,
);

const sys = useSession(system, "system");
const ctrl = useSession(controller, "controller", { passive: true });
const mc = useSession(manualControl, "manual-control", { passive: true });

// Live streams (docs/history/refactor/orchestrator.md §7.1 S4 added scope): render
// live streams only, and beyond ~8 collapse to an aggregate + top-N-by-Hz —
// don't build a wall of rows once stream capacity grows (ST-64, synced-
// capture thread).
const VISIBLE_STREAM_ROWS = 8;
const sortedStreams = computed(() =>
  [...ctrl.telemetry.streams].sort((a, b) => b.hz - a.hz),
);
const visibleStreams = computed(() =>
  sortedStreams.value.slice(0, VISIBLE_STREAM_ROWS),
);
const hiddenStreams = computed(() =>
  sortedStreams.value.slice(VISIBLE_STREAM_ROWS),
);
const hiddenHzTotal = computed(() =>
  hiddenStreams.value.reduce((a, s) => a + s.hz, 0),
);

const HISTORY = 60; // ~60 samples at the 1s poll tick below = 1 min window

function history(): number[] {
  return [];
}

const orchLoopLag = ref<number[]>(history());
const rendLoopLag = ref<number[]>(history());
const mcActuateMs = ref<number[]>(history());

function push(hist: { value: number[] }, v: number): void {
  hist.value = [...hist.value, v].slice(-HISTORY);
}

const snapshot = ref<PerfSnapshot | null>(null);
const spans = ref<Span[]>([]);
const prev = { snapshot: null as PerfSnapshot | null, t: 0 };

type Rate = {
  topic: string;
  hz: number;
  coalescePct: number;
  bytesPerSec: number;
};
const rates = ref<Rate[]>([]);

// Uniform per-workload sections (workload-metering.md §4) — the transform is
// pure (`./workload-view.ts`, unit-tested); this component only renders it.
// Fed from the same 1 Hz `perfSnapshot` poll + `prev` diff the channel-rate
// table already uses — no new wire messages.
const workloads = ref<WorkloadRow[]>([]);

// Bottleneck-first ordering (A-26): the busiest workload is almost always the
// fps cap, so sort by utilization descending and flag anything at/above the
// HIGH threshold as SATURATED — the saturated loop should be the first row and
// scream off the page (the user's snapshots put `registry:*` at ~0.99 while the
// native converters sit idle). Pure view concern; the transform stays name-
// sorted for stable section identity, we only reorder for display.
const sortedWorkloads = computed(() =>
  [...workloads.value].sort((a, b) => b.utilization - a.utilization),
);
const isSaturated = (utilization: number): boolean =>
  utilization >= UTILIZATION_HIGH;

// Pipeline graph (A-33/A-36, real-2 objective 1). STAGE 2: the orchestrator
// SERVES the topology (C-24's `graphTopology()`, riding `PerfSnapshot.graph` —
// exact byte rates from bytesTotal deltas, consumer sinks, session wirings);
// the Stage-1 renderer-side derivation (`deriveTopology`, pure + unit-tested,
// same 1 Hz workload rows + advertised pipes) remains the FALLBACK for an
// older orchestrator / graph builder not injected. Passive subscription:
// discovery state only, no pipe connects (fallback input).
const pipesSession = useSession(pipes, "pipes", { passive: true });
const graphSeq = ref(0);
const graphTopology = ref<GraphTopology | null>(null);

function computeRates(cur: PerfSnapshot): Rate[] {
  const now = Date.now();
  const dtSec = prev.snapshot ? Math.max(0.001, (now - prev.t) / 1000) : 0;
  const out: Rate[] = [];
  for (const [t, s] of Object.entries(cur.frames)) {
    const p = prev.snapshot?.frames[t];
    const sentDelta = p ? s.sent - p.sent : 0;
    const offeredDelta = p ? s.offered - p.offered : 0;
    const coalescedDelta = p ? s.coalesced - p.coalesced : 0;
    const bytesDelta = p ? s.bytes - p.bytes : 0;
    out.push({
      topic: t,
      hz: p && dtSec > 0 ? sentDelta / dtSec : 0,
      coalescePct: offeredDelta > 0 ? (100 * coalescedDelta) / offeredDelta : 0,
      bytesPerSec: p && dtSec > 0 ? bytesDelta / dtSec : 0,
    });
  }
  return out.sort((a, b) => a.topic.localeCompare(b.topic));
}

let timer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  // Session gone — freeze: keep the last-collected data on screen, poll no more
  // (the channel is dead; retrying only spams the console). Idempotent guard so
  // an in-flight tick that raced the down report also bails.
  if (sessionEnded.value) {
    stopPolling();
    return;
  }
  push(orchLoopLag, sys.telemetry.loopLag.mean);
  push(rendLoopLag, rendererLoopLag.stats.mean);
  push(mcActuateMs, mc.telemetry.perf.actuateMs.mean);
  spans.value = [...orchestratorSpans].slice(-50).reverse();
  try {
    const s = await sys.call("perfSnapshot", undefined);
    rates.value = computeRates(s);
    workloads.value = workloadRows(
      s.workloads ?? {},
      prev.snapshot?.workloads ?? null,
    );
    graphTopology.value = selectTopology(s.graph, () =>
      deriveTopology(
        workloads.value,
        pipesSession.state.pipes,
        ++graphSeq.value,
        Date.now(),
      ),
    );
    prev.snapshot = s;
    prev.t = Date.now();
    snapshot.value = s;
    // Server ring is the superset — covers spans that fired before this
    // window opened (the live topic.span feed cannot back-fill).
    if (s.spans?.length) spans.value = [...s.spans].slice(-50).reverse();
  } catch {
    // Orchestrator not reachable yet (e.g. this window opened before the
    // channel connected) — next tick retries.
  }
}

// Nav-bar pin toggle: keep the profiler above every other window
// (setAlwaysOnTop via the bridge). Persisted in localStorage so the choice
// survives reopen/reload; re-applied on mount (main only knows what we say).
const PIN_KEY = "profiler:pinned";
const pinned = ref(localStorage.getItem(PIN_KEY) === "1");
function togglePinned(): void {
  pinned.value = !pinned.value;
  localStorage.setItem(PIN_KEY, pinned.value ? "1" : "0");
  window.foveaBridge.setWindowPinned(pinned.value);
}

// Configurable report rate: how often the profiler polls `perfSnapshot`.
// This bounds how often edge stats (incl. max packet interval) are SAMPLED —
// the meters' capture windows are unaffected. Persisted so the choice
// survives reopen/reload.
const reportIntervalMs = ref(
  parseReportInterval(localStorage.getItem(REPORT_INTERVAL_KEY)),
);
function restartTimer(): void {
  stopPolling();
  if (sessionEnded.value) return; // frozen — never poll a dead session
  timer = setInterval(() => void tick(), reportIntervalMs.value);
}
watch(reportIntervalMs, (ms) => {
  localStorage.setItem(REPORT_INTERVAL_KEY, String(ms));
  restartTimer();
});
// The instant our instance goes down, freeze polling — no reconnect attempts.
watch(sessionEnded, (ended) => {
  if (ended) stopPolling();
});

onMounted(() => {
  void tick();
  restartTimer();
  if (pinned.value) window.foveaBridge.setWindowPinned(true);
});
onUnmounted(stopPolling);

// Export → result popup: the written path (or the failure) shows in a
// title-bar overlay (SnapshotOverlay, same mechanism as the recorder's
// RecordControls) instead of transient button-label states.
const exporting = ref(false);
async function exportSnapshot(): Promise<void> {
  // Capturing a NEW snapshot needs a live orchestrator (it fetches
  // `system.perfSnapshot`); once the session ended the button is disabled — the
  // already-collected data on screen stays browsable, it just can't grow.
  if (exporting.value || sessionEnded.value) return;
  exporting.value = true;
  try {
    snapshotResult.value = { path: await dumpPerfSnapshot() };
  } catch (e) {
    console.error(e);
    snapshotResult.value = { error: String(e) };
  } finally {
    exporting.value = false;
    overlay.value = { overlay: SnapshotOverlay };
  }
}

async function openSnapshotFolder(): Promise<void> {
  try {
    await window.foveaBridge.openPerfSnapshotFolder();
  } catch (e) {
    console.error(e);
  }
}

function fmt(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : "-";
}

// Clock-calibration health (unified-time proposal §3) — offsets are raw ns
// bigints stringified over the wire; render ms with µs jitter (>500µs jitter
// flags the row: the estimator's confidence is poor).
const clockRows = computed(() => {
  const clocks = snapshot.value?.clocks ?? {};
  return Object.entries(clocks).map(([id, c]) => ({
    id,
    method: c.method,
    offsetMs: (Number(BigInt(c.offsetNs) / 1000n) / 1000).toFixed(3),
    jitterUs: Math.round(Number(BigInt(c.jitterNs)) / 1000),
    samples: c.samples,
  }));
});

// Tabs (proposal §2 — the ~12-section scroll splits into a fixed tab strip
// behind the title bar; the Settings two-tab shell is the precedent). The graph
// is primary, so it is the default. Active tab persists across reloads via raw
// localStorage — the profiler already leans on it for the pin / report-rate /
// graph-height choices (@lib/local + url-state are for reactive session state;
// these are plain window prefs), so a fourth `profiler:*` key keeps that idiom.
const TAB_KEY = "profiler:tab";
type ProfilerTab = "graph" | "workloads" | "control" | "transport" | "system";
const TABS: { id: ProfilerTab; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "workloads", label: "Workloads" },
  { id: "control", label: "Control" },
  { id: "transport", label: "Transport" },
  { id: "system", label: "System" },
];
function parseTab(raw: string | null): ProfilerTab {
  return TABS.some((t) => t.id === raw) ? (raw as ProfilerTab) : "graph";
}
const activeTab = ref<ProfilerTab>(parseTab(localStorage.getItem(TAB_KEY)));
const tabContent = ref<HTMLElement | null>(null);
watch(activeTab, (t) => {
  localStorage.setItem(TAB_KEY, t);
  // Reset scroll on switch so a tab never opens mid-scroll (Settings precedent).
  tabContent.value?.scrollTo({ top: 0 });
});
</script>

<template>
  <TitleBar
    title="FoveaCam Duo"
    :subtitle="subtitle"
    @height="(h) => (titleBarHeight = h)"
  >
    <!-- Snapshot controls live on the title bar (the old header's h1 was
         redundant with the bar's subtitle). Icon-only buttons (FontAwesome,
         matching the recorder's title-bar chrome) sized for the ~40px bar;
         the export result (written path / failure) shows in the
         SnapshotOverlay popup, not inline. -->
    <div class="bar-actions">
      <select
        v-model.number="reportIntervalMs"
        class="report-rate"
        aria-label="Report rate"
        title="Report rate — how often perfSnapshot is polled; bounds how often edge stats (incl. max packet interval) are sampled"
      >
        <option v-for="o in REPORT_INTERVAL_OPTIONS" :key="o.ms" :value="o.ms">
          {{ o.label }}
        </option>
      </select>
      <button
        class="icon-btn pin"
        :class="{ active: pinned }"
        @click="togglePinned"
        :title="
          pinned
            ? 'Unpin — stop keeping this window on top'
            : 'Pin — keep this window on top'
        "
        :aria-label="pinned ? 'Unpin window' : 'Pin window on top'"
      >
        <Icon :icon="faThumbtack" />
      </button>
      <button
        class="icon-btn"
        @click="exportSnapshot"
        :disabled="exporting || sessionEnded"
        :title="
          sessionEnded
            ? 'Session ended — cannot capture a new snapshot (the orchestrator is gone)'
            : 'Write a perf snapshot JSON to disk'
        "
        aria-label="Export snapshot"
      >
        <Icon :icon="exporting ? faSpinner : faFileExport" :spin="exporting" />
      </button>
      <button
        class="icon-btn"
        @click="openSnapshotFolder"
        title="Reveal the perf-snapshots folder in Finder"
        aria-label="Open snapshots folder"
      >
        <Icon :icon="faFolderOpen" />
      </button>
    </div>
  </TitleBar>
  <div class="profiler" :style="{ top: titleBarHeight + 'px' }">
    <!-- Frozen session-end banner (ruling 2): layout-stable, always occupies
         the top of the body so the panels below never shift when it appears.
         Distinguishes a clean end from a crash off the typed down report. -->
    <div
      v-if="endState"
      class="session-banner"
      :class="{ crashed: endState.crashed }"
      role="status"
    >
      <span class="banner-title">{{ endState.title }}</span>
      <span class="banner-detail">{{ endState.detail }}</span>
    </div>

    <!-- Fixed tab strip behind the title bar (proposal §2; the Settings two-tab
         shell is the precedent) — never scrolls out of view, only .tab-content
         scrolls. The switch snaps (no transition, per the design language). -->
    <div class="tabs" role="tablist" aria-label="Profiler sections">
      <button
        v-for="t in TABS"
        :key="t.id"
        role="tab"
        :aria-selected="activeTab === t.id"
        class="tab"
        :class="{ active: activeTab === t.id }"
        @click="activeTab = t.id"
      >
        {{ t.label }}
      </button>
    </div>

    <div
      class="tab-content"
      :class="{ immersive: activeTab === 'graph' }"
      ref="tabContent"
    >
      <!-- ============ GRAPH (primary — gets the freed vertical space) ====== -->
      <section v-show="activeTab === 'graph'" class="graph-section">
        <div class="graph-host">
          <GraphPanel :topology="graphTopology" />
        </div>
      </section>

      <!-- ============ WORKLOADS ============ -->
      <section v-show="activeTab === 'workloads'">
        <h2>Workloads ({{ workloads.length }})</h2>
        <p class="hint" v-if="workloads.length === 0">
          No workload meters registered yet — camera preview loops, processing
          gates, and recorders appear here while live.
        </p>
        <div
          class="workload"
          :class="{ saturated: isSaturated(w.utilization) }"
          v-for="w in sortedWorkloads"
          :key="w.name"
        >
          <div class="workload-head">
            <span class="mono name">{{ w.name }}</span>
            <span v-if="isSaturated(w.utilization)" class="saturated-badge"
              >SATURATED</span
            >
            <div
              class="util-track"
              role="meter"
              :aria-valuenow="Math.round(w.utilization * 100)"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-label="w.name + ' utilization'"
            >
              <div
                class="util-fill"
                :class="utilizationLevel(w.utilization)"
                :style="{ width: (w.utilization * 100).toFixed(1) + '%' }"
              />
            </div>
            <span class="util-label">
              {{ fmt(w.utilization * 100) }}% busy
              <span class="dim"
                >· {{ w.interval ? "last tick" : "since start" }}</span
              >
            </span>
          </div>
          <table class="io-table">
            <tbody>
              <tr v-for="i in w.inputs" :key="'in:' + i.name">
                <td class="dir">in</td>
                <td class="mono">{{ i.name }}</td>
                <td class="num">{{ i.count.toLocaleString() }}</td>
                <td class="num">{{ fmt(i.ratePerSec) }}/s</td>
                <td
                  class="num interval"
                  :class="{ stall: i.stalled }"
                  title="max inter-arrival interval over the trailing 10 s"
                >
                  {{ fmt(i.maxIntervalMs) }} ms
                </td>
              </tr>
              <tr v-for="o in w.outputs" :key="'out:' + o.name">
                <td class="dir">out</td>
                <td class="mono">{{ o.name }}</td>
                <td class="num">{{ o.count.toLocaleString() }}</td>
                <td class="num">{{ fmt(o.ratePerSec) }}/s</td>
                <td
                  class="num interval"
                  :class="{ stall: o.stalled }"
                  title="max inter-arrival interval over the trailing 10 s"
                >
                  {{ fmt(o.maxIntervalMs) }} ms
                </td>
              </tr>
            </tbody>
          </table>
          <div class="drops mono" v-if="w.drops.total > 0">
            drops {{ w.drops.total.toLocaleString() }} ({{
              fmt(w.drops.ratePerSec)
            }}/s):
            <span
              v-for="d in w.drops.byReason"
              :key="d.reason"
              class="drop-reason"
            >
              {{ d.reason }} × {{ d.count.toLocaleString() }}
            </span>
          </div>
          <div class="drops mono dim" v-else>no drops</div>
        </div>
      </section>

      <section v-show="activeTab === 'workloads'">
        <h2>Event-loop lag</h2>
        <div class="row">
          <div class="stat">
            <label
              >Orchestrator (mean {{ fmt(sys.telemetry.loopLag.mean) }}ms / max
              {{ fmt(sys.telemetry.loopLag.max) }}ms)</label
            >
            <Sparkline :values="orchLoopLag" color="#0af" />
          </div>
          <div class="stat">
            <label
              >This window (mean {{ fmt(rendererLoopLag.stats.mean) }}ms / max
              {{ fmt(rendererLoopLag.stats.max) }}ms)</label
            >
            <Sparkline :values="rendLoopLag" color="#fa0" />
          </div>
        </div>
      </section>

      <!-- ============ CONTROL ============ -->
      <section v-show="activeTab === 'control'">
        <h2>Control-path latency</h2>
        <p class="hint" v-if="!mc.telemetry.ready">
          Manual-control is not active in any window — these read zero until it
          is.
        </p>
        <div class="row">
          <div class="stat">
            <label
              >manual-control.actuateMs (mean
              {{ fmt(mc.telemetry.perf.actuateMs.mean, 2) }}ms)</label
            >
            <Sparkline :values="mcActuateMs" color="#af0" />
          </div>
        </div>
      </section>

      <section v-show="activeTab === 'control'">
        <h2>Volt telemetry</h2>
        <div class="row">
          <div class="stat">
            <label>manual-control.volt</label>
            <div class="mono">
              L ({{ fmt(mc.telemetry.volt.L.x) }},
              {{ fmt(mc.telemetry.volt.L.y) }}) R ({{
                fmt(mc.telemetry.volt.R.x)
              }}, {{ fmt(mc.telemetry.volt.R.y) }})
            </div>
          </div>
          <div class="stat">
            <label>controller</label>
            <div class="mono">
              {{
                ctrl.telemetry.connected
                  ? ctrl.telemetry.enabled
                    ? "enabled"
                    : "connected"
                  : "disconnected"
              }}
              dv={{ fmt(ctrl.telemetry.dv) }}
            </div>
          </div>
        </div>
      </section>

      <section v-show="activeTab === 'control'">
        <h2>Serial data rate</h2>
        <p class="hint" v-if="!ctrl.telemetry.connected">
          Controller not connected — rates read zero until it is.
        </p>
        <div class="mono">
          tx
          {{
            Math.round(ctrl.telemetry.serialRate.txBytesPerSec).toLocaleString()
          }}
          B/s ({{ fmt(ctrl.telemetry.serialRate.txPacketsPerSec) }} pkt/s) · rx
          {{
            Math.round(ctrl.telemetry.serialRate.rxBytesPerSec).toLocaleString()
          }}
          B/s ({{ fmt(ctrl.telemetry.serialRate.rxPacketsPerSec) }} pkt/s)
        </div>
      </section>

      <!-- Serial PRESSURE (serial-rate-governor.md Part 3 — every new stat
         surfaces in the profiler, user ruling): governor rate vs requested,
         outq gauges, soft-fail counter, ACK-RTT percentiles, and the
         predictor's applied lookahead (Part 4). -->
      <section v-show="activeTab === 'control'">
        <h2>Serial pressure</h2>
        <p class="hint" v-if="!ctrl.telemetry.connected">
          Controller not connected — pressure reads zero until it is.
        </p>
        <div class="row">
          <div class="stat">
            <label>Stream rate (governor)</label>
            <div class="mono">
              {{ fmt(ctrl.telemetry.serialPressure.effectiveRateHz, 0) }} Hz /
              {{ fmt(ctrl.telemetry.serialPressure.ceilingHz, 0) }} Hz requested
              · {{ ctrl.telemetry.serialPressure.governorState }}
            </div>
          </div>
          <div class="stat">
            <label>Output queue</label>
            <div class="mono">
              <template v-if="ctrl.telemetry.serialPressure.outqSupported">
                {{ ctrl.telemetry.serialPressure.outqBytes }} B (hwm
                {{ ctrl.telemetry.serialPressure.outqHighWater }} B)
              </template>
              <template v-else>unsupported on this platform</template>
              · soft-fail {{ ctrl.telemetry.serialPressure.txSoftFail }}
            </div>
          </div>
        </div>
        <div class="row">
          <div class="stat">
            <label
              >ACK RTT (p50 / p95 / max over
              {{ ctrl.telemetry.serialPressure.ackRttMs.count }} samples)</label
            >
            <div class="mono">
              {{ fmt(ctrl.telemetry.serialPressure.ackRttMs.p50, 2) }} /
              {{ fmt(ctrl.telemetry.serialPressure.ackRttMs.p95, 2) }} /
              {{ fmt(ctrl.telemetry.serialPressure.ackRttMs.max, 2) }} ms
              (baseline
              {{
                fmt(ctrl.telemetry.serialPressure.ackRttMs.baselineP50, 2)
              }}
              ms)
            </div>
          </div>
          <div class="stat">
            <label>Predictor lookahead (applied)</label>
            <div class="mono">
              <template
                v-if="ctrl.telemetry.serialPressure.appliedLookaheadMs !== null"
              >
                {{
                  fmt(ctrl.telemetry.serialPressure.appliedLookaheadMs, 2)
                }}
                ms
              </template>
              <template v-else>— (no predictor active)</template>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ TRANSPORT ============ -->
      <section v-show="activeTab === 'transport'">
        <h2>Live streams ({{ sortedStreams.length }})</h2>
        <p class="hint" v-if="sortedStreams.length === 0">
          No CMD_STREAM targets active.
        </p>
        <div class="row">
          <div
            class="stat stream-row"
            v-for="stream in visibleStreams"
            :key="stream.id"
          >
            <label>stream #{{ stream.id }} — {{ fmt(stream.hz) }} Hz</label>
            <div class="stream-pads">
              <PosView
                :pos="stream.left"
                :lim="ctrl.telemetry.dv || 200"
                :font-size="10"
                color="cyan"
                style="width: 90px"
              />
              <PosView
                :pos="stream.right"
                :lim="ctrl.telemetry.dv || 200"
                :font-size="10"
                color="greenyellow"
                style="width: 90px"
              />
            </div>
          </div>
          <div class="stat" v-if="hiddenStreams.length > 0">
            <label>+{{ hiddenStreams.length }} more</label>
            <div class="mono">aggregate {{ fmt(hiddenHzTotal) }} Hz</div>
          </div>
        </div>
      </section>

      <section v-show="activeTab === 'transport'">
        <h2>Per-topic channel rates</h2>
        <table>
          <thead>
            <tr>
              <th>topic</th>
              <th>sent (Hz)</th>
              <th>coalesced (%)</th>
              <th>bytes/s</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rates" :key="r.topic">
              <td class="mono">{{ r.topic }}</td>
              <td>{{ fmt(r.hz) }}</td>
              <td>{{ fmt(r.coalescePct) }}</td>
              <td>{{ Math.round(r.bytesPerSec).toLocaleString() }}</td>
            </tr>
            <tr v-if="rates.length === 0">
              <td colspan="4" class="hint">No frame traffic observed yet.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-show="activeTab === 'transport'">
        <h2>Store-hub writes</h2>
        <div class="mono" v-if="snapshot">
          writes {{ snapshot.storeHub.writes }} · updates
          {{ snapshot.storeHub.updates }} · clears
          {{ snapshot.storeHub.clears }}
        </div>
      </section>

      <!-- ============ SYSTEM ============ -->
      <section v-show="activeTab === 'system' && clockRows.length > 0">
        <h2>Clocks</h2>
        <table>
          <thead>
            <tr>
              <th>clock</th>
              <th>method</th>
              <th>offset</th>
              <th>jitter</th>
              <th>n</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in clockRows" :key="c.id">
              <td class="mono">{{ c.id }}</td>
              <td>{{ c.method }}</td>
              <td class="mono">{{ c.offsetMs }} ms</td>
              <td class="mono" :class="{ saturated: c.jitterUs > 500 }">
                {{ c.jitterUs }} µs
              </td>
              <td>{{ c.samples }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-show="activeTab === 'system'">
        <h2>Diagnostics timeline (spans)</h2>
        <table>
          <thead>
            <tr>
              <th>t</th>
              <th>span</th>
              <th>ms</th>
              <th>meta</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in spans" :key="i">
              <td class="mono">{{ new Date(s.t).toLocaleTimeString() }}</td>
              <td class="mono">{{ s.name }}</td>
              <td>{{ fmt(s.ms, 2) }}</td>
              <td class="mono">{{ s.meta ? JSON.stringify(s.meta) : "" }}</td>
            </tr>
            <tr v-if="spans.length === 0">
              <td colspan="4" class="hint">
                No spans recorded yet this session.
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
// Snapshot controls in the title bar's actions slot (slot content compiles in
// this component's scope, so these stay scoped styles). Sized for the ~40px
// bar: compact padding, small monospace type matching the profiler body.
.bar-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0; // let the path truncate instead of pushing the bar wider
  font-family: var(--font-mono);

  button,
  select {
    background: var(--bg-app);
    color: var(--text-strong);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
    font-size: 0.72rem;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
    &:hover {
      background: var(--bg-elevated);
    }
  }

  // Icon-only bar buttons (FontAwesome — no emoji-as-icon): square hit
  // target, meaning carried by the tooltip + aria-label.
  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.7rem;
    height: 1.5rem;
    padding: 0;
    font-size: 0.78rem;

    &:disabled {
      cursor: default;
      opacity: 0.6;
    }
  }

  .pin.active {
    background: #74b1be;
    color: #10161a;
    border-color: #74b1be;
    &:hover {
      background: #86bfca;
    }
  }
}

.profiler {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  // Fixed tab strip + independently-scrolling content (proposal §2): the
  // profiler itself no longer scrolls — it is a flex column whose header
  // (banner + tab strip) stays put while only .tab-content scrolls.
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* profiler panel is intentionally darker than app chrome (its own sub-theme) */
  background: #0b0b0d;
  color: var(--text-strong);
  font-family: var(--font-mono);
  box-sizing: border-box;

  // Tab strip — mirrors the Settings shell (ConfigBody): a 2px transparent
  // bottom border on every tab so selecting only recolors it (no layout shift),
  // and the switch snaps (no transition) per the design language.
  .tabs {
    flex-shrink: 0;
    display: flex;
    gap: 0.4ch;
    padding: 0.5rem 1.5rem 0;
    border-bottom: 1px solid var(--bg-app);
  }

  .tab {
    font-family: inherit;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    padding: 0.4em 0.9em;
    cursor: pointer;
    outline: none;
    &:hover {
      color: var(--text-strong);
    }
    &:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    &.active {
      color: var(--text-strong);
      border-bottom-color: var(--accent-bright);
    }
  }

  .tab-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1rem 1.5rem 3rem;

    // Graph tab (ruling 3): the graph fills the tab container and never scrolls;
    // every OTHER tab keeps its normal vertical scroll.
    &.immersive {
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 0;
    }
  }

  // The graph section fills the tab (the graph is primary and gets the freed
  // vertical space); the SVG node graph auto-scales with the profiler window
  // (no in-panel resize handle anymore — ruling 3).
  .graph-section {
    margin-bottom: 0;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;

    // The heading + hint stay their natural size; the graph host takes the rest.
    .graph-host {
      flex: 1;
      min-height: 0;
    }
  }

  section {
    margin-bottom: 1.5rem;
    h2 {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin: 0 0 0.5rem;
      border-bottom: 1px solid var(--bg-app);
      padding-bottom: 0.25rem;
    }
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .stream-pads {
    display: flex;
    flex-direction: row;
    gap: 0.5rem;
  }

  .stat {
    label {
      display: block;
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 0.25rem;
    }
  }

  .mono {
    font-family: inherit;
    font-size: 0.85rem;
  }

  .dim {
    color: var(--text-disabled);
  }

  // Uniform workload sections (workload-metering.md §4). The utilization
  // meter is a thin single-value bar; the % is always printed in text ink
  // beside it, so the status tint (ok/warn/high) is redundant encoding,
  // never color-alone.
  .workload {
    padding: 0.5rem 0;
    border-bottom: 1px solid #161618;
    &:last-child {
      border-bottom: none;
    }

    // Saturated workload = the bottleneck (A-26). A red left rail + tinted
    // backdrop pulls the eye straight to it above the sorted-descending list.
    &.saturated {
      border-left: 3px solid #f56;
      padding-left: 0.6rem;
      margin-left: -0.75rem;
      background: linear-gradient(
        90deg,
        rgba(255, 85, 102, 0.08),
        transparent 60%
      );
    }

    .workload-head {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.3rem;

      .name {
        min-width: 16rem;
        color: var(--text-strong);
      }

      .saturated-badge {
        flex: 0 0 auto;
        margin-left: -0.5rem;
        padding: 0.05rem 0.4rem;
        border-radius: 3px;
        background: #f56;
        color: #1a0004;
        font-size: 0.65rem;
        font-weight: 700;
        letter-spacing: 0.04em;
      }

      .util-track {
        flex: 0 0 160px;
        height: 8px;
        border-radius: 4px;
        background: var(--bg-panel-alt);
        overflow: hidden;

        .util-fill {
          height: 100%;
          border-radius: 4px;
          background: var(--accent-bright);
          transition: width 0.3s ease;
          &.warn {
            background: var(--warn);
          }
          // profiler "high/saturated" coral — its own alarm hue, kept literal
          &.high {
            background: #f56;
          }
        }
      }

      .util-label {
        font-size: 0.8rem;
        color: var(--text-muted);
        white-space: nowrap;
      }
    }

    .io-table {
      width: auto;
      margin-left: 1rem;
      td {
        border-bottom: none;
        padding: 0.05rem 1rem 0.05rem 0;
      }
      .dir {
        color: var(--text-disabled);
        text-transform: uppercase;
        font-size: 0.7rem;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      // C-18: max inter-arrival (10 s). Dim by default; a stalled stream (gap
      // > 2× nominal period) turns amber + bold so it reads at a glance — the
      // number is always printed, so the tint is redundant, never color-alone.
      .interval {
        color: var(--text-faint);
      }
      // profiler stall amber — a distinct "stalled stream" hue, kept literal
      .interval.stall {
        color: #e0a030;
        font-weight: 600;
      }
    }

    .drops {
      margin: 0.15rem 0 0 1rem;
      font-size: 0.8rem;
      // Neutral ink on purpose: coalescing is *expected* for latest-wins
      // gates — an alarm tint here would cry wolf. The utilization tint
      // (warn/high) is the only status encoding in this section.
      .drop-reason {
        margin-left: 0.75rem;
        color: var(--text-muted);
      }
    }
  }

  .hint {
    color: var(--text-disabled);
    font-style: italic;
    font-size: 0.8rem;
  }

  // Frozen session-end banner (ruling 2). Layout-stable: reserves its own strip
  // at the top of the body so nothing below jumps when it appears. Clean/killed
  // end = neutral amber notice; a crash = the shared danger identity (tokens).
  .session-banner {
    // Fixed header element (above the tab strip): its own margins now that
    // .profiler carries no padding, so it stays inset from the window edges and
    // is visible on every tab (a frozen session must never be tab-hidden).
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin: 0.85rem 1.5rem 0.35rem;
    padding: 0.6rem 0.85rem;
    border-radius: 6px;
    border: 1px solid var(--border-strong);
    border-left: 3px solid var(--warn);
    background: var(--bg-panel-alt);

    .banner-title {
      font-size: 0.85rem;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: var(--warn);
    }
    .banner-detail {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    &.crashed {
      border-color: var(--danger-strong);
      border-left-color: var(--danger-strong);
      background: var(--danger-bg);
      .banner-title {
        color: var(--danger-text);
      }
      .banner-detail {
        color: var(--danger-text);
      }
    }
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
    th,
    td {
      text-align: left;
      padding: 0.2rem 0.6rem 0.2rem 0;
      border-bottom: 1px solid var(--bg-panel-alt);
    }
    th {
      color: var(--text-muted);
      font-weight: 500;
    }
  }
}
</style>
