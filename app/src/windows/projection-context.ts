// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Projection split-view — the controller the window shell provides to its panes
// and split nodes.
// ProjectionWindow owns the split tree + all mutation; the recursive
// SplitNode/ProjectionPane components stay thin and call up through this
// injected surface instead of a deep emit chain. Vue-type-only import.

import type { InjectionKey } from "vue";
import type { DropZone } from "@lib/projection/split-tree";
import type { PaneDragPayload } from "@lib/projection/descriptor";
import type { PaneLifecycle } from "@lib/projection/termination";

export interface ProjectionController {
  /** This window's stable `?win=` id — panes stamp it into a drag payload so a
   *  drop can tell a within-window move from a cross-window one. */
  readonly windowId: string | null;
  /** Divider drag: shift `deltaFraction` of the split at `path`'s axis across
   *  divider `index` (min-size clamped in the reducer). */
  resize(path: number[], index: number, deltaFraction: number): void;
  /** A pane's close button. Removing the last pane closes the window. */
  closePane(paneId: string): void;
  /** A drop landed on `targetId`'s `zone`. The controller resolves move/copy +
   *  same/cross-window and mutates the tree. */
  dropOnPane(
    targetId: string,
    zone: DropZone,
    payload: PaneDragPayload,
    mods: { alt: boolean },
  ): void;
  /** A pane header drag started (records the source for the move-on-dragend
   *  removal path). */
  beginDrag(paneId: string): void;
  /** A pane header drag ended — `dropEffect` is the event's resolved effect
   *  ("move" removes the source unless a same-window move already re-docked it). */
  endDrag(paneId: string, dropEffect: string): void;
  /** A pane's termination status changed — drives the all-terminated auto-close. */
  reportStatus(paneId: string, status: PaneLifecycle): void;
}

export const PROJECTION_CTL: InjectionKey<ProjectionController> =
  Symbol("projection-controller");
