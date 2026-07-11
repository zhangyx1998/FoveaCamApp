<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  One projection pane (docs/proposals/projection-split-view.md deliverable
  2/3/5). A slim VSCode-tab-like header (title + grip + close) is the DRAG
  SURFACE; the body renders the bound feed on the EXISTING payload paths:
    - {kind:"frame"} → a PASSIVE `useSession().frame()` ref (never activates the
      source session; frame refs are already rAF-coalesced),
    - {kind:"pipe"}  → `usePipeFrame(id)` over the pipes session (epoch-aware).
  No new frame plumbing — the pane is a thin host over those two refs.

  Termination/rebind (deliverable 5): a `TerminationMachine` drives
  live → frozen(cover) → rebound | terminated off observable signals — the
  channel death (`orchestratorDown`) and the feed's payload stopping/resuming
  (a pipe un-advertise nulls the payload; a fresh frame resumes it). While
  frozen the LAST frame stays on screen under a dismissible "source has closed"
  cover; a rebind (frames flow again) clears it; the grace timer promotes to
  terminated only if nothing returns. The window's auto-close watches the
  aggregate status via `reportStatus`.

  Drop zones (deliverable 4): the pane body is a drop target — the pointer
  position picks a VSCode-style zone (edge quadrant = split, center =
  move/swap); a live highlight previews where the drop lands.
-->
<script setup lang="ts">
import { computed, inject, onScopeDispose, ref, shallowRef, watch } from "vue";
import { useSession, usePipeFrame, orchestratorDown } from "@lib/orchestrator/client";
import { defineContract } from "@lib/orchestrator/protocol";
import type { FramePayload } from "@lib/orchestrator/protocol";
import StreamView from "../components/StreamView.vue";
import { paneLabel, parseDragPayload, serializeDragPayload, type Pane } from "@lib/projection/descriptor";
import { dropZoneAt, PANE_MIME } from "@lib/projection/dnd";
import type { DropZone } from "@lib/projection/split-tree";
import { TerminationMachine, type PaneLifecycle } from "@lib/projection/termination";
import { PROJECTION_CTL } from "./projection-context";

const props = defineProps<{ pane: Pane }>();
const ctl = inject(PROJECTION_CTL)!;

// Minimal read-only contract for a frame pane — same anonymous shape the
// single-stream projection window used: empty state + the near-universal
// `ready` telemetry flag (an idle note, distinct from the closed cover).
const frameContract = defineContract({
  state: {},
  telemetry: { ready: true as boolean },
  frames: [] as const,
  commands: {},
});

// ---- Source binding (one of the two existing payload paths) ----------------
const isPipe = computed(() => props.pane.source.kind === "pipe");
const frameSession =
  props.pane.source.kind === "frame"
    ? useSession(frameContract, props.pane.source.session, { passive: true })
    : null;
const framePayload = computed<FramePayload | null>(() =>
  props.pane.source.kind === "frame"
    ? (frameSession?.frame(props.pane.source.frame).payload.value ?? null)
    : null,
);
const pipePayload =
  props.pane.source.kind === "pipe"
    ? usePipeFrame(props.pane.source.id)
    : shallowRef<FramePayload | null>(null);
const livePayload = computed<FramePayload | null>(() =>
  isPipe.value ? pipePayload.value : framePayload.value,
);

// The last non-null frame we displayed — kept so a frozen pane shows the last
// image even when the pipe path nulls its payload on un-advertise.
const lastFrame = shallowRef<FramePayload | null>(null);
// What the canvas shows: the live payload, else the frozen last frame.
const shown = computed<FramePayload | null>(() => livePayload.value ?? lastFrame.value);

// ---- Termination machine ---------------------------------------------------
const status = ref<PaneLifecycle>("live");
const coverVisible = ref(false);
const machine = new TerminationMachine({
  onChange: (s) => {
    status.value = s.status;
    coverVisible.value = s.coverVisible;
    ctl.reportStatus(props.pane.id, s.status);
  },
});
onScopeDispose(() => machine.dispose());

// Payload transitions → lost/returned. A fresh frame after any loss rebinds; a
// payload dropping to null AFTER we've shown a frame (pipe un-advertise) freezes.
watch(
  livePayload,
  (p, prev) => {
    if (p) {
      lastFrame.value = p;
      if (status.value !== "live") machine.sourceReturned();
    } else if (prev && lastFrame.value) {
      machine.sourceLost();
    }
  },
  { immediate: true },
);
// Channel death (orchestratorDown) freezes every pane; the grace timer then
// waits for a new instance's frames to resume (→ rebind) before terminating.
watch(orchestratorDown, (down) => {
  if (down) machine.sourceLost();
});

// Idle note (frame panes only): the source session paused but the channel is
// alive — distinct from the "source has closed" cover.
const idle = computed(
  () => !isPipe.value && status.value === "live" && frameSession?.telemetry.ready === false,
);

const title = computed(() => paneLabel(props.pane));

// ---- Header drag (the drag surface) ----------------------------------------
function onHeaderDragStart(e: DragEvent): void {
  if (!e.dataTransfer) return;
  ctl.beginDrag(props.pane.id);
  e.dataTransfer.setData(
    PANE_MIME,
    serializeDragPayload({ pane: props.pane, srcWindowId: ctl.windowId, origin: "projection" }),
  );
  e.dataTransfer.effectAllowed = "copyMove";
}
function onHeaderDragEnd(e: DragEvent): void {
  ctl.endDrag(props.pane.id, e.dataTransfer?.dropEffect ?? "none");
}

// ---- Drop target (the whole pane; zone from the pointer) -------------------
const dropZone = ref<DropZone | null>(null);
const body = ref<HTMLElement | null>(null);

function zoneFromEvent(e: DragEvent): DropZone {
  const el = body.value;
  if (!el) return "center";
  const r = el.getBoundingClientRect();
  return dropZoneAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
}
function hasPaneData(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(PANE_MIME);
}
function onDragOver(e: DragEvent): void {
  if (!hasPaneData(e)) return;
  e.preventDefault();
  if (e.dataTransfer) {
    // Clamp dropEffect to what the SOURCE allows: an app-origin drag advertises
    // `effectAllowed:"copy"` (copy-only), so forcing "move" would make the
    // browser REFUSE the drop — read effectAllowed and only offer move when the
    // source permits it. Otherwise Alt = copy, default = move.
    const allowed = e.dataTransfer.effectAllowed;
    e.dataTransfer.dropEffect =
      allowed === "copy" || allowed === "copyLink" || allowed === "link"
        ? "copy"
        : e.altKey
          ? "copy"
          : "move";
  }
  dropZone.value = zoneFromEvent(e);
}
function onDragLeave(e: DragEvent): void {
  // Ignore leaves into child elements (relatedTarget still inside the pane).
  if (body.value && e.relatedTarget instanceof Node && body.value.contains(e.relatedTarget))
    return;
  dropZone.value = null;
}
function onDrop(e: DragEvent): void {
  if (!hasPaneData(e)) return;
  e.preventDefault();
  const zone = zoneFromEvent(e);
  dropZone.value = null;
  const payload = parseDragPayload(e.dataTransfer!.getData(PANE_MIME));
  if (!payload) return;
  ctl.dropOnPane(props.pane.id, zone, payload, { alt: e.altKey });
}
</script>

<template>
  <div class="pane" :class="{ dragover: dropZone !== null }">
    <!-- Slim header = the drag surface (grip + title + close). -->
    <div
      class="pane-header"
      :draggable="true"
      :title="title"
      @dragstart="onHeaderDragStart"
      @dragend="onHeaderDragEnd"
    >
      <span class="grip" aria-hidden="true">⋮⋮</span>
      <span class="pane-title">{{ title }}</span>
      <span v-if="status === 'terminated'" class="term-tag" title="Source terminated">ended</span>
      <button class="close" title="Close pane" @click="ctl.closePane(pane.id)">✕</button>
    </div>

    <!-- Body = the feed + the drop target + overlays. -->
    <div
      class="pane-body"
      ref="body"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <StreamView
        class="pane-stream"
        :payload="shown"
        :projectable="false"
        :theme="pane.theme ?? 'gray'"
        width="100%"
        height="100%"
      />

      <div v-if="!shown" class="notice">Waiting for {{ title }}…</div>
      <div v-else-if="idle" class="idle-note">source idle — last frame</div>

      <!-- Frozen cover — dismissible, distinct from the idle note. -->
      <div v-if="coverVisible" class="cover" role="status">
        <div class="cover-text">source has closed</div>
        <button class="cover-dismiss" @click="machine.dismissCover()">Dismiss</button>
      </div>

      <!-- Drop-zone highlight (VSCode-style). -->
      <div v-if="dropZone" class="drop-hint" :class="`zone-${dropZone}`" aria-hidden="true"></div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.pane {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--bg-canvas);
  outline: 1px solid var(--border);
  &.dragover {
    outline-color: var(--accent-bright);
  }
}

.pane-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.6ch;
  height: 1.9em;
  padding: 0 0.6ch;
  background: var(--bg-chrome);
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: var(--fs-sm);
  cursor: grab;
  user-select: none;
  &:active {
    cursor: grabbing;
  }

  .grip {
    color: var(--text-disabled);
    letter-spacing: -0.2ch;
  }
  .pane-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .term-tag {
    color: var(--danger-text);
    font-size: 0.85em;
  }
  .close {
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    padding: 0 0.3ch;
    &:hover {
      color: var(--text);
    }
  }
}

.pane-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;

  .pane-stream {
    width: 100%;
    height: 100%;
  }
}

.notice {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 1em;
  text-align: center;
  padding: 1em;
  pointer-events: none;
}

.idle-note {
  position: absolute;
  top: 0.6em;
  right: 0.8em;
  color: var(--text-dim);
  background: #000a; /* translucent scrim over the canvas (alpha kept literal) */
  border: 1px solid var(--tint-3);
  border-radius: 3px;
  padding: 0.1em 0.7em;
  font-size: var(--fs-sm);
  pointer-events: none;
}

.cover {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.8em;
  background: #000a; /* dim the frozen frame beneath (alpha kept literal) */
  backdrop-filter: blur(1px);

  .cover-text {
    color: var(--danger-text);
    font-size: 1.1em;
  }
  .cover-dismiss {
    background: var(--bg-elevated);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    padding: 0.3em 1.2em;
    cursor: pointer;
    &:hover {
      border-color: var(--border-muted);
    }
  }
}

// VSCode-style drop preview: a translucent accent block over the half/center
// the drop will land in. Snap (no transition) per the design ruling.
.drop-hint {
  position: absolute;
  background: color-mix(in srgb, var(--accent-bright) 30%, transparent);
  outline: 1px solid var(--accent-bright);
  pointer-events: none;
  &.zone-center {
    inset: 0;
  }
  &.zone-left {
    top: 0;
    bottom: 0;
    left: 0;
    width: 50%;
  }
  &.zone-right {
    top: 0;
    bottom: 0;
    right: 0;
    width: 50%;
  }
  &.zone-top {
    left: 0;
    right: 0;
    top: 0;
    height: 50%;
  }
  &.zone-bottom {
    left: 0;
    right: 0;
    bottom: 0;
    height: 50%;
  }
}
</style>
