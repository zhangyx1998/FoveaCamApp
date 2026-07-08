<!-- ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 --------------------------------------------------------- -->

<!-- The profiler window (docs/refactor/orchestrator.md §7.1 S4/V12) — a
     second `BrowserWindow`, read-only over existing telemetry. `system` is the
     always-on session and stays active; controller/tracking/manual-control are
     passive observers so opening the profiler never starts actuation loops or
     camera taps. -->

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useSession, rendererLoopLag, orchestratorSpans, dumpPerfSnapshot } from "@lib/orchestrator/client";
import { system, controller, type PerfSnapshot, type Span } from "@lib/orchestrator/contracts";
import { tracking } from "@modules/tracking-single/contract";
import { manualControl } from "@modules/manual-control/contract";
import { workloadRows, utilizationLevel, UTILIZATION_HIGH, type WorkloadRow } from "./workload-view";
import { pipes } from "@lib/orchestrator/pipe-contract";
import type { GraphTopology } from "@lib/orchestrator/graph-contract";
import { deriveTopology, selectTopology } from "./graph-view";
import GraphPanel from "./GraphPanel.vue";
import Sparkline from "../components/Sparkline.vue";
import PosView from "@src/components/PosView.vue";
import TitleBar from "../components/TitleBar.vue";

// Shared window chrome (A-7): the profiler BrowserWindow now uses the same
// hidden-titlebar overlay as every other window class.
const titleBarHeight = ref(0);

const sys = useSession(system, "system");
const ctrl = useSession(controller, "controller", { passive: true });
const trk = useSession(tracking, "tracking", { passive: true });
const mc = useSession(manualControl, "manual-control", { passive: true });

// Live streams (docs/refactor/orchestrator.md §7.1 S4 added scope): render
// live streams only, and beyond ~8 collapse to an aggregate + top-N-by-Hz —
// don't build a wall of rows once stream capacity grows (ST-64, synced-
// capture thread).
const VISIBLE_STREAM_ROWS = 8;
const sortedStreams = computed(() => [...ctrl.telemetry.streams].sort((a, b) => b.hz - a.hz));
const visibleStreams = computed(() => sortedStreams.value.slice(0, VISIBLE_STREAM_ROWS));
const hiddenStreams = computed(() => sortedStreams.value.slice(VISIBLE_STREAM_ROWS));
const hiddenHzTotal = computed(() => hiddenStreams.value.reduce((a, s) => a + s.hz, 0));

const HISTORY = 60; // ~60 samples at the 1s poll tick below = 1 min window

function history(): number[] {
  return [];
}

const orchLoopLag = ref<number[]>(history());
const rendLoopLag = ref<number[]>(history());
const trackMs = ref<number[]>(history());
const actuateMs = ref<number[]>(history());
const frameAge = ref<number[]>(history());
const mcActuateMs = ref<number[]>(history());

function push(hist: { value: number[] }, v: number): void {
  hist.value = [...hist.value, v].slice(-HISTORY);
}

const snapshot = ref<PerfSnapshot | null>(null);
const spans = ref<Span[]>([]);
const prev = { snapshot: null as PerfSnapshot | null, t: 0 };

type Rate = { topic: string; hz: number; coalescePct: number; bytesPerSec: number };
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
const isSaturated = (utilization: number): boolean => utilization >= UTILIZATION_HIGH;

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

async function tick(): Promise<void> {
  push(orchLoopLag, sys.telemetry.loopLag.mean);
  push(rendLoopLag, rendererLoopLag.stats.mean);
  push(trackMs, trk.telemetry.perf.trackMs.mean);
  push(actuateMs, trk.telemetry.perf.actuateMs.mean);
  push(frameAge, trk.telemetry.perf.frameAgeAtActuate.mean);
  push(mcActuateMs, mc.telemetry.perf.actuateMs.mean);
  spans.value = [...orchestratorSpans].slice(-50).reverse();
  try {
    const s = await sys.call("perfSnapshot", undefined);
    rates.value = computeRates(s);
    workloads.value = workloadRows(s.workloads ?? {}, prev.snapshot?.workloads ?? null);
    graphTopology.value = selectTopology(s.graph, () =>
      deriveTopology(workloads.value, pipesSession.state.pipes, ++graphSeq.value, Date.now()),
    );
    prev.snapshot = s;
    prev.t = Date.now();
    snapshot.value = s;
  } catch {
    // Orchestrator not reachable yet (e.g. this window opened before the
    // channel connected) — next tick retries.
  }
}

onMounted(() => {
  void tick();
  timer = setInterval(() => void tick(), 1000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const exportStatus = ref<"" | "saving" | "saved" | "error">("");
const savedPath = ref<string>(""); // last written snapshot file (shown in the UI)
async function exportSnapshot(): Promise<void> {
  exportStatus.value = "saving";
  try {
    savedPath.value = await dumpPerfSnapshot();
    exportStatus.value = "saved";
  } catch (e) {
    console.error(e);
    exportStatus.value = "error";
  } finally {
    setTimeout(() => (exportStatus.value = ""), 2000);
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
</script>

<template>
  <TitleBar title="FoveaCam Duo" subtitle="Profiler" @height="(h) => (titleBarHeight = h)" />
  <div class="profiler" :style="{ top: titleBarHeight + 'px' }">
    <header>
      <h1>Orchestrator Profiler</h1>
      <div class="snapshot-controls">
        <button @click="exportSnapshot">
          {{ exportStatus === "saving" ? "Saving…" : exportStatus === "saved" ? "Saved" : exportStatus === "error" ? "Failed" : "Export snapshot" }}
        </button>
        <button @click="openSnapshotFolder" title="Reveal the perf-snapshots folder in Finder">
          Open snapshot folder
        </button>
        <span v-if="savedPath" class="saved-path mono" :title="savedPath">{{ savedPath }}</span>
      </div>
    </header>

    <section>
      <h2>Event-loop lag</h2>
      <div class="row">
        <div class="stat">
          <label>Orchestrator (mean {{ fmt(sys.telemetry.loopLag.mean) }}ms / max {{ fmt(sys.telemetry.loopLag.max) }}ms)</label>
          <Sparkline :values="orchLoopLag" color="#0af" />
        </div>
        <div class="stat">
          <label>This window (mean {{ fmt(rendererLoopLag.stats.mean) }}ms / max {{ fmt(rendererLoopLag.stats.max) }}ms)</label>
          <Sparkline :values="rendLoopLag" color="#fa0" />
        </div>
      </div>
    </section>

    <section>
      <h2>Workloads ({{ workloads.length }})</h2>
      <p class="hint" v-if="workloads.length === 0">
        No workload meters registered yet — camera preview loops, processing gates, and recorders appear here while live.
      </p>
      <div
        class="workload"
        :class="{ saturated: isSaturated(w.utilization) }"
        v-for="w in sortedWorkloads"
        :key="w.name"
      >
        <div class="workload-head">
          <span class="mono name">{{ w.name }}</span>
          <span v-if="isSaturated(w.utilization)" class="saturated-badge">SATURATED</span>
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
            <span class="dim">· {{ w.interval ? "last tick" : "since start" }}</span>
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
          drops {{ w.drops.total.toLocaleString() }} ({{ fmt(w.drops.ratePerSec) }}/s):
          <span v-for="d in w.drops.byReason" :key="d.reason" class="drop-reason">
            {{ d.reason }} × {{ d.count.toLocaleString() }}
          </span>
        </div>
        <div class="drops mono dim" v-else>no drops</div>
      </div>
    </section>

    <section>
      <h2>Pipeline graph</h2>
      <p class="hint">
        Live stream topology — node badges show util% · rate · worst gap (drops when nonzero);
        saturated (≥90%) nodes are flagged red. Stage-1 view derived from meters + advertised pipes.
      </p>
      <GraphPanel :topology="graphTopology" />
    </section>

    <section>
      <h2>Control-path latency</h2>
      <p class="hint" v-if="!trk.telemetry.ready && !mc.telemetry.ready">
        Neither tracking nor manual-control is active in any window — these read zero until one is.
      </p>
      <div class="row">
        <div class="stat">
          <label>tracking.trackMs (mean {{ fmt(trk.telemetry.perf.trackMs.mean, 2) }}ms)</label>
          <Sparkline :values="trackMs" color="#0af" />
        </div>
        <div class="stat">
          <label>tracking.actuateMs (mean {{ fmt(trk.telemetry.perf.actuateMs.mean, 2) }}ms)</label>
          <Sparkline :values="actuateMs" color="#0af" />
        </div>
        <div class="stat">
          <label>tracking.frameAgeAtActuate (mean {{ fmt(trk.telemetry.perf.frameAgeAtActuate.mean) }}ms)</label>
          <Sparkline :values="frameAge" color="#0af" />
        </div>
        <div class="stat">
          <label>manual-control.actuateMs (mean {{ fmt(mc.telemetry.perf.actuateMs.mean, 2) }}ms)</label>
          <Sparkline :values="mcActuateMs" color="#af0" />
        </div>
      </div>
    </section>

    <section>
      <h2>Volt telemetry</h2>
      <div class="row">
        <div class="stat">
          <label>tracking.volt</label>
          <div class="mono">
            L ({{ fmt(trk.telemetry.volt.L.x) }}, {{ fmt(trk.telemetry.volt.L.y) }})
            R ({{ fmt(trk.telemetry.volt.R.x) }}, {{ fmt(trk.telemetry.volt.R.y) }})
          </div>
        </div>
        <div class="stat">
          <label>manual-control.volt</label>
          <div class="mono">
            L ({{ fmt(mc.telemetry.volt.L.x) }}, {{ fmt(mc.telemetry.volt.L.y) }})
            R ({{ fmt(mc.telemetry.volt.R.x) }}, {{ fmt(mc.telemetry.volt.R.y) }})
          </div>
        </div>
        <div class="stat">
          <label>controller</label>
          <div class="mono">
            {{ ctrl.telemetry.connected ? (ctrl.telemetry.enabled ? "enabled" : "connected") : "disconnected" }}
            dv={{ fmt(ctrl.telemetry.dv) }}
          </div>
        </div>
      </div>
    </section>

    <section>
      <h2>Serial data rate</h2>
      <p class="hint" v-if="!ctrl.telemetry.connected">Controller not connected — rates read zero until it is.</p>
      <div class="mono">
        tx {{ Math.round(ctrl.telemetry.serialRate.txBytesPerSec).toLocaleString() }} B/s
        ({{ fmt(ctrl.telemetry.serialRate.txPacketsPerSec) }} pkt/s) ·
        rx {{ Math.round(ctrl.telemetry.serialRate.rxBytesPerSec).toLocaleString() }} B/s
        ({{ fmt(ctrl.telemetry.serialRate.rxPacketsPerSec) }} pkt/s)
      </div>
    </section>

    <section>
      <h2>Live streams ({{ sortedStreams.length }})</h2>
      <p class="hint" v-if="sortedStreams.length === 0">No CMD_STREAM targets active.</p>
      <div class="row">
        <div class="stat stream-row" v-for="stream in visibleStreams" :key="stream.id">
          <label>stream #{{ stream.id }} — {{ fmt(stream.hz) }} Hz</label>
          <div class="stream-pads">
            <PosView :pos="stream.left" :lim="ctrl.telemetry.dv || 200" :font-size="10" color="cyan" style="width: 90px" />
            <PosView :pos="stream.right" :lim="ctrl.telemetry.dv || 200" :font-size="10" color="greenyellow" style="width: 90px" />
          </div>
        </div>
        <div class="stat" v-if="hiddenStreams.length > 0">
          <label>+{{ hiddenStreams.length }} more</label>
          <div class="mono">aggregate {{ fmt(hiddenHzTotal) }} Hz</div>
        </div>
      </div>
    </section>

    <section>
      <h2>Per-topic channel rates</h2>
      <table>
        <thead>
          <tr><th>topic</th><th>sent (Hz)</th><th>coalesced (%)</th><th>bytes/s</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rates" :key="r.topic">
            <td class="mono">{{ r.topic }}</td>
            <td>{{ fmt(r.hz) }}</td>
            <td>{{ fmt(r.coalescePct) }}</td>
            <td>{{ Math.round(r.bytesPerSec).toLocaleString() }}</td>
          </tr>
          <tr v-if="rates.length === 0"><td colspan="4" class="hint">No frame traffic observed yet.</td></tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>Store-hub writes</h2>
      <div class="mono" v-if="snapshot">
        writes {{ snapshot.storeHub.writes }} · updates {{ snapshot.storeHub.updates }} · clears {{ snapshot.storeHub.clears }}
      </div>
    </section>

    <section>
      <h2>Boot / activation timeline</h2>
      <table>
        <thead>
          <tr><th>t</th><th>span</th><th>ms</th><th>meta</th></tr>
        </thead>
        <tbody>
          <tr v-for="(s, i) in spans" :key="i">
            <td class="mono">{{ new Date(s.t).toLocaleTimeString() }}</td>
            <td class="mono">{{ s.name }}</td>
            <td>{{ fmt(s.ms, 2) }}</td>
            <td class="mono">{{ s.meta ? JSON.stringify(s.meta) : "" }}</td>
          </tr>
          <tr v-if="spans.length === 0"><td colspan="4" class="hint">No spans recorded yet this session.</td></tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped lang="scss">
.profiler {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  overflow: auto;
  background: #0b0b0d;
  color: #ddd;
  font-family: "Cascadia Code", "Courier New", Courier, monospace;
  padding: 1rem 1.5rem 3rem;
  box-sizing: border-box;

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
    h1 {
      font-size: 1.1rem;
      font-weight: 600;
      margin: 0;
    }
    button {
      background: #222;
      color: #ddd;
      border: 1px solid #333;
      border-radius: 4px;
      padding: 0.4rem 0.8rem;
      cursor: pointer;
      &:hover {
        background: #2a2a2a;
      }
    }
    .snapshot-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0; // let the path truncate instead of overflowing the header
      .saved-path {
        color: #888;
        font-size: 0.72rem;
        max-width: 22rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        direction: rtl; // keep the filename visible when truncating
        text-align: left;
      }
    }
  }

  section {
    margin-bottom: 1.5rem;
    h2 {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #999;
      margin: 0 0 0.5rem;
      border-bottom: 1px solid #222;
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
      color: #aaa;
      margin-bottom: 0.25rem;
    }
  }

  .mono {
    font-family: inherit;
    font-size: 0.85rem;
  }

  .dim {
    color: #777;
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
      background: linear-gradient(90deg, rgba(255, 85, 102, 0.08), transparent 60%);
    }

    .workload-head {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.3rem;

      .name {
        min-width: 16rem;
        color: #ddd;
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
        background: #1a1a1a;
        overflow: hidden;

        .util-fill {
          height: 100%;
          border-radius: 4px;
          background: #0af;
          transition: width 0.3s ease;
          &.warn {
            background: #fa0;
          }
          &.high {
            background: #f56;
          }
        }
      }

      .util-label {
        font-size: 0.8rem;
        color: #aaa;
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
        color: #777;
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
        color: #888;
      }
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
        color: #aaa;
      }
    }
  }

  .hint {
    color: #777;
    font-style: italic;
    font-size: 0.8rem;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
    th,
    td {
      text-align: left;
      padding: 0.2rem 0.6rem 0.2rem 0;
      border-bottom: 1px solid #1a1a1a;
    }
    th {
      color: #999;
      font-weight: 500;
    }
  }
}
</style>
