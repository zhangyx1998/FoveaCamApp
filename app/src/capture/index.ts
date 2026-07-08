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
// (`App.vue`) and `capture/index.vue` already depend on — only
// `manual-control/index.vue` ever constructs one, for exactly as long as it's
// mounted, same lifetime as before.

import { onScopeDispose, shallowRef } from "vue";
import { SavePath } from "@lib/save-path";
import type { Session } from "@lib/orchestrator/client";
import type { ManualControlContract, VoltPreviewQuery } from "@modules/manual-control/contract";

export const current_capture = shallowRef<Capture | null>(null);

// `FrameView.vue`/`StreamView.vue`'s generic string/function `capture` prop
// mechanism (`current_capture.value?.provide(...)`) — kept only so those
// (widely-shared, untouched) components still typecheck. Nothing in
// manual-control passes a string `capture` prop anymore (the "wide" resource
// is captured entirely server-side, see `modules/manual-control/capture.ts`),
// so this is never actually invoked.
export type Delegation = (handler: () => unknown) => () => void;

export default class Capture extends SavePath {
  constructor(
    public readonly session: Session<ManualControlContract>,
    namespace: string,
    /** The overlay (`capture/index.vue`) has no access to manual-control's
     *  local set-points list — it asks for the current one via this, called
     *  fresh on every `run()`. */
    private readonly getSetpoints: () => VoltPreviewQuery[],
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

  /** No-op — see the `Delegation` comment above. */
  provide(_handler: (provide: (name: string, data: unknown) => void) => unknown): () => void {
    return () => {};
  }

  run(): Promise<void> {
    return this.session.call("runCapture", { setpoints: this.getSetpoints() });
  }

  save(path: string, format: string): Promise<void> {
    return this.session.call("saveCapture", { path, format });
  }

  discard(): Promise<void> {
    return this.session.call("discardCapture", undefined);
  }
}
