// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Thin renderer facade over a session's recording commands (the orchestrator
// owns the raw stream writers): forwards `start`/`stop`, mirrors
// `recording_active`/`recordingStreams` telemetry into the `active`/`streams`
// shape RecordButton/RecordControls read, and keeps the save-path UI state.

import { onScopeDispose, reactive, shallowRef, toRef, watch, type Ref } from "vue";
import { SavePath } from "@lib/save-path";
import type { Session } from "@lib/orchestrator/client";
import type { Contract, Command } from "@lib/orchestrator/protocol";

export type StreamInfo = {
  frames: number;
  dropped: number;
  /** F2 drop attribution (`droppedQueue + droppedRing == dropped`). Optional so
   *  a session whose contract predates the split still assigns cleanly — the
   *  data rides the telemetry object at runtime regardless (RecordButton reads
   *  `?? 0`). */
  droppedQueue?: number;
  droppedRing?: number;
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
    // `recording_active` is a boolean on the contract, but over the open type
    // parameter `TelemetryOf<C>` newer `toRef` typings (Vue 3.5) can't narrow
    // the generic value back to `boolean` — same generic-erasure cast as above.
    this.active = toRef(this.session.telemetry, "recording_active") as Ref<boolean>;
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
