// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import type { FoveaBridge } from "./electron/bridge";

declare global {
  type Sequence<T = any> = Iterable<T> & {
    length: number;
    [index: number]: T;
  };

  type Awaitable<T> = T | Promise<T>;

  type Mutable<T> = { -readonly [P in keyof T]: T[P] };

  type BufferLike = Buffer | ArrayBuffer | ArrayBufferView;

  type Empty = null | undefined;

  interface Window {
    /** Exposed by `electron/preload.ts` via `contextBridge.exposeInMainWorld`
     *  — the renderer's only path to the main process once `contextIsolation`
     *  flips on (docs/history/refactor/orchestrator.md §7.1 T5). Present under
     *  today's `nodeIntegration: true` too (`contextBridge` falls back to a
     *  direct `window` assignment when isolation is off), so renderer code
     *  can use it unconditionally. */
    foveaBridge: FoveaBridge;
  }
}

declare module "*.py?raw" {
  const src: string;
  export default src;
}
