<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Right-click STREAM STATS popover for the standalone viewer (viewer-timeline).
  A compact, in-window overlay (NOT a native menu) anchored near the cursor and
  pre-clamped by the parent (stats.ts `clampPopover`). Purely presentational:
  the parent (ViewerWindow) owns open/dismiss, the get-stats request, and the
  clamp; this renders the static + live rows.

  Design-language BINDING: instant feedback (no fade-in/transition), layout
  stability (every live row is always present — it shows "…" until the engine
  reply lands, so the box never resizes when data arrives). Tokens only,
  monospace-aligned label/value rows.
-->
<script setup lang="ts">
import type { StreamLiveStats } from "./protocol";
import {
  formatDuration,
  formatFps,
  formatLive,
  formatPixelFormat,
  formatResolution,
  type StreamStaticStats,
} from "./stats";

/** One stream section: its label ("" for a single tile, "L"/"R" for a merged
 *  pair), its static stats, and the latest live snapshot (null until it lands). */
export interface StatsEntry {
  label: string;
  stat: StreamStaticStats;
  live: StreamLiveStats | null;
}

const props = defineProps<{
  x: number;
  y: number;
  entries: StatsEntry[];
  /** Current playhead, file-relative ns — the "frame vs playhead" comparison. */
  playheadNs: number;
  /** Whether the tile's stream is enabled (not v-toggled off). */
  enabled: boolean;
  /** Global 3D mode when this tile is a merged pair; null for a single tile. */
  threeDMode: string | null;
}>();
</script>

<template>
  <div class="stats-popover" :style="{ left: props.x + 'px', top: props.y + 'px' }" role="dialog">
    <div class="live-head">
      <span class="live-state" :class="{ off: !props.enabled }">
        {{ props.enabled ? "enabled" : "disabled" }}
      </span>
      <span v-if="props.threeDMode" class="threed-tag">3D: {{ props.threeDMode }}</span>
      <span class="playhead" title="Playhead position">▶ {{ formatDuration(props.playheadNs) }}</span>
    </div>

    <section v-for="entry in props.entries" :key="entry.label + entry.stat.name" class="stream">
      <div class="stream-head">
        <span v-if="entry.label" class="side">{{ entry.label }}</span>
        <span class="name">{{ entry.stat.name }}</span>
      </div>
      <dl class="rows">
        <div class="row"><dt>format</dt><dd>{{ formatPixelFormat(entry.stat) }}</dd></div>
        <div class="row">
          <dt>resolution</dt>
          <dd>{{ formatResolution(entry.stat.width, entry.stat.height) }}<span class="ch">×{{ entry.stat.channels }}ch</span></dd>
        </div>
        <div class="row">
          <dt>messages</dt>
          <dd>{{ entry.stat.messageCount ?? "—" }}<span class="ch"> · {{ formatFps(entry.stat.avgFps) }} avg</span></dd>
        </div>
        <div class="row"><dt>span</dt><dd>{{ formatDuration(entry.stat.spanNs) }}</dd></div>
        <div class="row live"><dt>decoded</dt><dd>{{ formatLive(entry.live).decoded }}</dd></div>
        <div class="row live"><dt>rate</dt><dd>{{ formatLive(entry.live).rate }}</dd></div>
        <div class="row live"><dt>frame</dt><dd>{{ formatLive(entry.live).lastFrame }}</dd></div>
      </dl>
    </section>
  </div>
</template>

<style scoped lang="scss">
.stats-popover {
  position: fixed;
  z-index: 200;
  min-width: 26ch;
  max-width: 40ch;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  box-shadow: 0 6px 22px var(--shadow);
  padding: 0.5em 0.7em 0.6em;
  color: var(--text-dim);
  font-size: 0.82em;
  // SNAP: no transition on this feedback path (instant appearance).
  * {
    user-select: none;
  }
}

.live-head {
  display: flex;
  align-items: center;
  gap: 0.8ch;
  padding-bottom: 0.4em;
  margin-bottom: 0.4em;
  border-bottom: 1px solid var(--tint-1);
  font-family: var(--font-mono);
  font-size: 0.92em;

  .live-state {
    color: var(--ok);
    &.off {
      color: var(--text-disabled);
    }
  }
  .threed-tag {
    color: var(--accent-bright);
  }
  .playhead {
    margin-left: auto;
    color: var(--text-faint);
  }
}

.stream {
  & + .stream {
    margin-top: 0.5em;
    padding-top: 0.4em;
    border-top: 1px solid var(--tint-1);
  }
  .stream-head {
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    margin-bottom: 0.3em;
    .side {
      color: var(--accent-bright);
      font-weight: 600;
      font-family: var(--font-mono);
    }
    .name {
      color: var(--text-bright);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }
}

.rows {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 1.2ch;
  row-gap: 0.12em;

  .row {
    display: contents;
    dt {
      color: var(--text-faint);
    }
    dd {
      margin: 0;
      text-align: right;
      font-family: var(--font-mono);
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    &.live dd {
      color: var(--text-bright);
    }
    .ch {
      color: var(--text-disabled);
    }
  }
}
</style>
