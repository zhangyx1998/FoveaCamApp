// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Renderer-safe wire contract for the SHM transfer MessagePort. Both the
// renderer pool and the unsandboxed preload import this file so buffer
// ownership fields cannot drift between the two ends.

import type { FramePayload } from "./protocol.js";

export const SHM_READ = "fovea:shm:read";
export const SHM_READ_DONE = "fovea:shm:read-done";
export const SHM_INIT = "fovea:shm:init";

export type ShmReadRequest = {
  kind: typeof SHM_READ;
  id: number;
  payload: FramePayload;
  buffer: ArrayBuffer;
};

export type ShmReadDone = {
  kind: typeof SHM_READ_DONE;
  id: number;
  payload: FramePayload | null;
  buffer?: ArrayBuffer;
  error?: string;
};
