// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// A fake in-memory `Endpoint` pair (docs/refactor/orchestrator.md §7.1 item
// 2) — two `Endpoint`s wired to each other's `onMessage`, so a real
// `Channel` on each side drives the other end-to-end with zero Electron/DOM/
// native involvement. This is the exact mock point `protocol.ts` already
// designed for (the same `Endpoint` shape wraps a DOM `MessagePort` in
// `client.ts` and an Electron `MessagePortMain` in `runtime.ts`); nothing
// new needed here beyond the wiring.
//
// Delivery is async (`queueMicrotask`), matching real `MessagePort` semantics
// (never synchronous with the `post()` call) — tests that need to observe a
// delivered message should `await flush()` or any promise that resolves
// after a microtask turn.

import type { Endpoint } from "@lib/orchestrator/protocol";

export function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

export function createEndpointPair(): [Endpoint, Endpoint] {
  let onA: ((msg: any) => void) | null = null;
  let onB: ((msg: any) => void) | null = null;
  let aClosed = false;
  let bClosed = false;

  const a: Endpoint = {
    post: (data) => {
      if (aClosed) return;
      queueMicrotask(() => {
        if (!bClosed) onB?.(data);
      });
    },
    onMessage: (cb) => {
      onA = cb;
    },
    close: () => {
      aClosed = true;
    },
  };

  const b: Endpoint = {
    post: (data) => {
      if (bClosed) return;
      queueMicrotask(() => {
        if (!aClosed) onA?.(data);
      });
    },
    onMessage: (cb) => {
      onB = cb;
    },
    close: () => {
      bClosed = true;
    },
  };

  return [a, b];
}
