// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Thin renderer facade over the manual-control session's recording commands
// (docs/history/refactor/orchestrator.md roadmap item 6) — the orchestrator now owns
// the raw stream writers (see `orchestrator/stream-writer.ts`,
// `modules/manual-control/recording.ts`); this class just forwards
// `start`/`stop` and mirrors `recording_active`/`recordingStreams` telemetry
// into the same `active`/`streams` shape `RecordButton.vue`/`RecordControls.vue`
// already read, plus keeps the save-path UI state (`SavePath`), a pure
// renderer concern independent of where the frames are written.

import { onScopeDispose, reactive, shallowRef, toRef, watch, type Ref } from "vue";
import { SavePath } from "@lib/save-path";
import type { Session } from "@lib/orchestrator/client";
import type { Contract, Command } from "@lib/orchestrator/protocol";

export type StreamInfo = {
  frames: number;
  dropped: number;
  fps: number;
  bytes: number;
};

/** The minimal contract shape a recording-capable session must expose (wave
 *  I-2: multi-fovea reuses the manual-control facade verbatim — same command
 *  names, same telemetry field names). */
export type RecordableContract = Contract & {
  telemetry: {
    recording_active: boolean;
    recordingStreams: Record<string, StreamInfo>;
  };
  commands: {
    startRecording: Command<{ path: string }, boolean>;
    stopRecording: Command<void, void>;
  };
};

export const current_recording = shallowRef<Recording<RecordableContract> | null>(null);

export default class Recording<C extends RecordableContract> extends SavePath {
  readonly active: Ref<boolean>;
  // A genuine `Map` (not the contract's plain object) so `RecordButton.vue`'s
  // `v-for="[name, info] of streams"` needs no template change.
  readonly streams = reactive(new Map<string, StreamInfo>());

  constructor(
    private readonly session: Session<C>,
    namespace: string,
  ) {
    super(namespace);
    if (current_recording.value !== null)
      throw new Error(
        `A recording context is already active for "${current_recording.value.namespace}".`,
      );
    // The singleton is typed on the minimal contract — a widening reference
    // cast (C extends RecordableContract; the button only touches the shared
    // surface).
    current_recording.value = this as unknown as Recording<RecordableContract>;
    this.active = toRef(this.session.telemetry, "recording_active");
    watch(
      () => this.session.telemetry.recordingStreams,
      (obj) => {
        this.streams.clear();
        for (const [name, info] of Object.entries(obj)) this.streams.set(name, info);
      },
      { immediate: true },
    );
    onScopeDispose(() => this.dispose());
  }

  dispose() {
    if ((current_recording.value as unknown) === this) current_recording.value = null;
  }

  async start(path: string): Promise<boolean> {
    return this.session.call("startRecording", { path });
  }

  async stop(): Promise<boolean> {
    await this.session.call("stopRecording", undefined);
    return true;
  }
}
