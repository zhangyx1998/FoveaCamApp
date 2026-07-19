<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Projection window — a VSCode-style SPLIT-PANE shell. This
  component OWNS the recursive split tree and every mutation; the recursive
  SplitNode / ProjectionPane children stay thin over the pure reducer
  (`@lib/projection/split-tree`) and call up through the injected controller.

  State-in-URL: the live layout is serialized into `?layout=`
  (the `?win` state-in-URL precedent) on every change, so a reload / manifest
  restore replays the EXACT layout. The initial seed resolves in precedence:
    ?layout  (a full tree)  →  ?pane  (one serialized descriptor)
                            →  legacy ?session=&frame=  (a single frame pane).

  Cross-window DnD: panes advertise a descriptor under the
  custom MIME; a drop resolves move/copy (default move; Alt = copy; app-origin
  drags are copy-only) and same-/cross-window here, then mutates the tree. A
  same-window move is atomic (`movePane`); a cross-window move inserts a fresh
  copy and the SOURCE window removes its pane on its `move` dragend. Removing the
  last pane (a move-out or a close) closes the window.

  Auto-close: when EVERY pane is `terminated` and the new
  `projection_auto_close` global config is on, the window closes itself.
-->
<script setup lang="ts">
import { computed, provide, reactive, ref, watch } from "vue";
import TitleBar from "../components/TitleBar.vue";
import SplitNode from "./SplitNode.vue";
import { PROJECTION_CTL, type ProjectionController } from "./projection-context";
import { windowId as readWindowId, writeUrlState } from "@lib/url-state";
import { useConfigRef } from "@lib/config";
import {
  freshPaneId,
  parsePane,
  type PaneDragPayload,
} from "@lib/projection/descriptor";
import {
  insertPane,
  movePane,
  panes,
  paneCount,
  parseTree,
  removePane,
  resizeDivider,
  serializeTree,
  singleLeaf,
  type DropZone,
  type SplitTree,
} from "@lib/projection/split-tree";
import { isNoopDrop, resolveIntent } from "@lib/projection/dnd";
import { allTerminated, type PaneLifecycle } from "@lib/projection/termination";

const props = defineProps<{
  layout: string;
  pane: string;
  session: string;
  frame: string;
}>();

const titleBarHeight = ref(0);
const windowId = readWindowId();

// ---- Initial tree (precedence: layout → pane → legacy session/frame) --------
function seedTree(): SplitTree | null {
  const fromLayout = parseTree(props.layout);
  if (fromLayout) return fromLayout;
  const fromPane = parsePane(props.pane);
  if (fromPane) return singleLeaf(fromPane);
  if (props.session && props.frame)
    return singleLeaf({
      id: freshPaneId(),
      source: { kind: "frame", session: props.session, frame: props.frame },
    });
  return null;
}
const tree = ref<SplitTree | null>(seedTree());

// ---- Per-pane termination status (drives auto-close) ------------------------
const statuses = reactive<Record<string, PaneLifecycle>>({});

// ---- Global auto-close config (live across windows) -------------------------
const autoClose = ref(true);
void useConfigRef("projection_auto_close")
  .then((r) => watch(r, (v) => (autoClose.value = v ?? true), { immediate: true }))
  .catch(() => {});

let closed = false;
function closeWindow(): void {
  if (closed) return;
  closed = true;
  window.close();
}

// Serialize the live layout into the URL on every change (idempotent write), so
// reload + manifest restore replay it; drop the now-stale seed params.
watch(
  tree,
  (t) => {
    if (!t) return;
    writeUrlState({ layout: serializeTree(t), pane: null, session: null, frame: null });
    // Prune statuses for panes that no longer exist, then re-check auto-close.
    const ids = new Set(panes(t).map((p) => p.id));
    for (const id of Object.keys(statuses)) if (!ids.has(id)) delete statuses[id];
    maybeAutoClose();
  },
  { deep: false },
);

function maybeAutoClose(): void {
  const t = tree.value;
  if (!t || !autoClose.value) return;
  const list = panes(t).map((p) => statuses[p.id] ?? "live");
  if (allTerminated(list)) closeWindow();
}

// A same-window move applies the tree change atomically in `dropOnPane`; its
// source dragend must then NOT also remove the pane. This flag bridges the two.
let localMoveConsumed = false;

const controller: ProjectionController = {
  windowId,
  resize(path, index, delta) {
    if (tree.value) tree.value = resizeDivider(tree.value, path, index, delta);
  },
  closePane(paneId) {
    if (!tree.value) return;
    const next = removePane(tree.value, paneId);
    if (!next) closeWindow();
    else tree.value = next;
  },
  dropOnPane(targetId: string, zone: DropZone, payload: PaneDragPayload, mods) {
    if (!tree.value) return;
    const sameWindow = payload.srcWindowId !== null && payload.srcWindowId === windowId;
    const intent = resolveIntent(payload.origin, mods);
    if (isNoopDrop({ intent, sameWindow, draggedPaneId: payload.pane.id, targetPaneId: targetId }))
      return;
    if (intent === "move" && sameWindow) {
      // Atomic within-window re-dock; the source dragend skips its removal.
      tree.value = movePane(tree.value, payload.pane.id, targetId, zone);
      localMoveConsumed = true;
    } else {
      // Copy, or a cross-window move: insert a FRESH-id copy (a cross-window
      // move's source removes its own pane on its `move` dragend).
      const fresh = { ...payload.pane, id: freshPaneId() };
      tree.value = insertPane(tree.value, targetId, fresh, zone);
    }
  },
  beginDrag() {
    localMoveConsumed = false;
  },
  endDrag(paneId, dropEffect) {
    if (localMoveConsumed) {
      localMoveConsumed = false;
      return;
    }
    // A cross-window MOVE succeeded elsewhere → remove our copy of the pane.
    if (dropEffect === "move" && tree.value) {
      const next = removePane(tree.value, paneId);
      if (!next) closeWindow();
      else tree.value = next;
    }
  },
  reportStatus(paneId, status) {
    statuses[paneId] = status;
    maybeAutoClose();
  },
};
provide(PROJECTION_CTL, controller);

const count = computed(() => (tree.value ? paneCount(tree.value) : 0));
const subtitle = computed(() =>
  count.value === 0 ? "no stream" : count.value === 1 ? "1 stream" : `${count.value} streams`,
);
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <div v-if="!tree" class="notice">
      Missing stream address (?layout=…, ?pane=…, or ?session=…&amp;frame=…)
    </div>
    <SplitNode v-else :node="tree" :path="[]" />
  </div>
  <TitleBar title="Projection" :subtitle="subtitle" @height="(h) => (titleBarHeight = h)" />
</template>

<style scoped lang="scss">
.main {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
  background: var(--bg-canvas);
  * {
    user-select: none;
  }
}

.notice {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 1.1em;
  text-align: center;
  padding: 2em;
}
</style>
