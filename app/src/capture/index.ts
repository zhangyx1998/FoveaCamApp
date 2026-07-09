// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Thin renderer facade over the manual-control session's capture commands
// (docs/history/refactor/orchestrator.md roadmap item 6) — the orchestrator now does
// all the camera/vision work (stack/wrap/diff at full bit depth, held
// server-side until save), this class just forwards `run`/`save`/`discard`
// and keeps the save-path UI state (`SavePath`: sequence/current_path),
// which is a pure renderer concern independent of where the pixels live.
//
// `current_capture` keeps the same global-registration shape the title bar
// (`AppWindow.vue`) depends on — the camera icon gates on it and toggles the
// capture-preview window (`manual-control/CapturePreview.vue`, a `debug`-class
// window per capture-recorder-nodes.md ruling 8). Only
// `manual-control/index.vue` ever constructs one, for exactly as long as it's
// mounted, same lifetime as before. (The retired title-bar overlay
// `capture/index.vue` was deleted with ruling 6.)

import { onScopeDispose, shallowRef } from "vue";
import { SavePath } from "@lib/save-path";
import type { FramePayload } from "@lib/orchestrator/protocol";
import type { Session } from "@lib/orchestrator/client";
import type { ManualControlContract } from "@modules/manual-control/contract";

export const current_capture = shallowRef<Capture | null>(null);

export default class Capture extends SavePath {
  constructor(
    public readonly session: Session<ManualControlContract>,
    namespace: string,
  ) {
    super(namespace);
    if (current_capture.value !== null)
      throw new Error(
        `A capture is already in progress for namespace "${current_capture.value.namespace}".`,
      );
    current_capture.value = this;
    onScopeDispose(() => this.dispose());
  }

  dispose() {
    if (current_capture.value === this) current_capture.value = null;
  }

  /** Run ONE capture shot (capture-recorder-nodes Phase 3/4). `tag` accumulates
   *  an indexed resource (a raster shot); absent/0 starts a fresh accumulation.
   *  Awaitable — resolves once the node has stacked + held that shot. */
  capture(tag?: number): Promise<void> {
    return this.session.call("capture", { tag });
  }

  /** Pull one held resource's ACTUAL data (ruling 7), downconverted to 8-bit
   *  BGRA by the node. `index` selects an entry of a raster resource. */
  getPreview(resource: string, index?: number): Promise<FramePayload | null> {
    return this.session.call("getPreview", { resource, index });
  }

  save(path: string, format: string): Promise<void> {
    return this.session.call("saveCapture", { path, format });
  }

  discard(): Promise<void> {
    return this.session.call("discardCapture", undefined);
  }
}
