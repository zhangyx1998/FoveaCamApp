// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Thin renderer facade over a capturable session's capture commands
// (capture-recorder-everywhere ruling 3). GENERALIZED off manual-control: the
// orchestrator does all the camera/vision work (stack/wrap/diff at full bit
// depth, held server-side until save) — this class forwards
// `captureShot`/`getCapturePreview`/`saveCapture`/`discardCapture` (the mixin
// command names) and keeps the save-path UI state (`SavePath`), a pure renderer
// concern independent of where the pixels live.
//
// Typed on the minimal `CapturableContract` (mixin subset) so ANY app that
// spread `captureCommands()`/`captureTelemetry()` can construct one — same
// widening-cast precedent as `@src/record`'s `Recording`. The facade's PUBLIC
// method names (`capture`/`getPreview`/`save`/`discard`) are unchanged so
// manual-control/index.vue + SaveControls need no edit.
//
// `current_capture` keeps the same global-registration shape the title bar
// (`AppWindow.vue`) depends on — the camera icon gates on it and toggles the
// shared capture-preview window. An app's index.vue constructs one for exactly
// as long as it's mounted; the passive preview window constructs its own (a
// per-window global, no collision).

import { onScopeDispose, shallowRef } from "vue";
import { SavePath } from "@lib/save-path";
import type { FramePayload } from "@lib/orchestrator/protocol";
import type { Session } from "@lib/orchestrator/client";
import type { CapturableContract } from "./contract";

export const current_capture = shallowRef<Capture<CapturableContract> | null>(null);

export default class Capture<C extends CapturableContract = CapturableContract> extends SavePath {
  constructor(
    public readonly session: Session<C>,
    namespace: string,
  ) {
    super(namespace);
    if (current_capture.value !== null)
      throw new Error(
        `A capture is already in progress for namespace "${current_capture.value.namespace}".`,
      );
    current_capture.value = this as unknown as Capture<CapturableContract>;
    onScopeDispose(() => this.dispose());
  }

  dispose() {
    if ((current_capture.value as unknown) === this) current_capture.value = null;
  }

  /** Run ONE capture shot. `tag` accumulates an indexed resource (a raster
   *  shot); absent/0 starts a fresh accumulation. Awaitable — resolves once the
   *  node has stacked + held that shot. */
  capture(tag?: number): Promise<void> {
    return this.session.call("captureShot", { tag });
  }

  /** Pull one held resource's ACTUAL data (ruling 7), downconverted to 8-bit
   *  BGRA by the node. `index` selects an entry of a raster resource. */
  getPreview(resource: string, index?: number): Promise<FramePayload | null> {
    return this.session.call("getCapturePreview", { resource, index });
  }

  save(path: string, format: string): Promise<void> {
    return this.session.call("saveCapture", { path, format });
  }

  discard(): Promise<void> {
    return this.session.call("discardCapture", undefined);
  }
}
