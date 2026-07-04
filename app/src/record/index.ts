// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Thin renderer facade over the manual-control session's recording commands
// (docs/refactor/orchestrator.md roadmap item 6) — the orchestrator now owns
// the raw stream writers (see `orchestrator/stream-writer.ts`,
// `modules/manual-control/recording.ts`); this class just forwards
// `start`/`stop` and mirrors `recording_active`/`recording_streams` telemetry
// into the same `active`/`streams` shape `RecordButton.vue`/`RecordControls.vue`
// already read, plus keeps the save-path UI state (`SavePath`), a pure
// renderer concern independent of where the frames are written.

import { onScopeDispose, reactive, shallowRef, toRef, watch, type Ref } from "vue";
import { SavePath } from "@lib/save-path";
import type { Session } from "@lib/orchestrator/client";
import type { ManualControlContract } from "@modules/manual-control/contract";

export type StreamInfo = {
  frames: number;
  dropped: number;
  fps: number;
  bytes: number;
};

export const current_recording = shallowRef<Recording | null>(null);

export default class Recording extends SavePath {
  readonly active: Ref<boolean>;
  // A genuine `Map` (not the contract's plain object) so `RecordButton.vue`'s
  // `v-for="[name, info] of streams"` needs no template change.
  readonly streams = reactive(new Map<string, StreamInfo>());

  constructor(
    private readonly session: Session<ManualControlContract>,
    namespace: string,
  ) {
    super(namespace);
    if (current_recording.value !== null)
      throw new Error(
        `A recording context is already active for "${current_recording.value.namespace}".`,
      );
    current_recording.value = this;
    this.active = toRef(this.session.telemetry, "recording_active");
    watch(
      () => this.session.telemetry.recording_streams,
      (obj) => {
        this.streams.clear();
        for (const [name, info] of Object.entries(obj)) this.streams.set(name, info);
      },
      { immediate: true },
    );
    onScopeDispose(() => this.dispose());
  }

  dispose() {
    if (current_recording.value === this) current_recording.value = null;
  }

  async start(path: string): Promise<boolean> {
    return this.session.call("startRecording", { path });
  }

  async stop(): Promise<boolean> {
    await this.session.call("stopRecording", undefined);
    return true;
  }
}
