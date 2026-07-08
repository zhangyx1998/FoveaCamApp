// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// State-in-URL helper (docs/refactor/multi-window.md req. 7 / §4): stateful
// windows expose internal state in their URL so a dev restart / manifest
// restore lands back in the same internal state, not just the same window.
// The orchestrator session stays authoritative — the URL is the *address* of
// that state, not a second copy: components sync state → URL with
// `history.replaceState` (no navigation, no history spam) and read the URL
// exactly once on load to seed the session.
//
// State rides the QUERY STRING, not a path subpath: packaged windows load
// via `loadFile(file, { search })`, where a path subpath would break file://
// resolution — the query string is the one URL slot that rides both the dev
// server URL and the packaged file URL unchanged (req. 7's "subpath" is
// satisfied in spirit: the state lives in the window's URL).
//
// Renderer-only (history/location APIs). Deliberately framework-free — Vue
// callers just wrap `writeUrlState` in a `watchEffect`.

import { WINDOW_ID_PARAM } from "./windows.js";

/** Read one state param from the current window URL (null = absent). */
export function readUrlParam(key: string): string | null {
  return new URLSearchParams(location.search).get(key);
}

/** Read all current state params (a copy — mutations don't write back). */
export function readUrlState(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(location.search));
}

/** This window's stable instance id (A-34) — minted by the window manager at
 *  spawn and threaded here via `?win=` (see `WINDOW_ID_PARAM`), so it survives
 *  reloads + manifest restores. Null only for windows that predate the manager
 *  (shouldn't happen in practice). Static per window — read once, no reactivity
 *  needed. C-24's composition addresses this window's nodes as
 *  `win/<windowId>/...`. */
export function windowId(): string | null {
  return readUrlParam(WINDOW_ID_PARAM);
}

/**
 * Merge `patch` into the URL's query string via `history.replaceState`
 * (null values delete the key). Idempotent: rewriting the same state is a
 * no-op, so calling from a reactive effect on every state echo is safe.
 */
export function writeUrlState(patch: Record<string, string | null>): void {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const search = params.toString();
  const next = location.pathname + (search ? `?${search}` : "") + location.hash;
  const current = location.pathname + location.search + location.hash;
  if (next !== current) history.replaceState(history.state, "", next);
}
