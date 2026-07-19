// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Minimal CAPTURE contract — the mixin telemetry/commands only. The shared
// `CapturePreview` window is a PASSIVE
// viewer over ANY capturable app's session, so it can't import the app's full
// contract; it subscribes with this minimal shape instead (the WS protocol is
// name-based — the telemetry stream carries every field, this just types the
// capture subset). Same widening-cast precedent as `@src/record`'s
// `RecordableContract`.

import { defineContract } from "@lib/orchestrator/protocol";
import type { Command, Contract, FramePayload, Serializable } from "@lib/orchestrator/protocol";
import { captureCommands, captureTelemetry } from "@lib/orchestrator/contracts";

/** The minimal contract a capture-capable session exposes — mixin names only. */
export const captureContract = defineContract({
  state: {},
  telemetry: { ...captureTelemetry() },
  frames: [] as const,
  commands: { ...captureCommands() },
});

export type CaptureContract = typeof captureContract;

/** The structural shape the generic `Capture` facade requires — any app
 *  contract that spread `captureTelemetry()`/`captureCommands()` satisfies it
 *  (manual-control ALSO keeps its legacy `capture`/`getPreview`, a superset). */
export type CapturableContract = Contract & {
  telemetry: {
    captureBusy: boolean;
    capture_meta: Record<string, Serializable>;
  };
  commands: {
    captureShot: Command<{ tag?: number }, void>;
    getCapturePreview: Command<{ resource: string; index?: number }, FramePayload | null>;
    saveCapture: Command<{ path: string; format: string }, void>;
    discardCapture: Command<void, void>;
  };
};
