// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { ref } from "vue";
import { getDateTimeString } from "./util/string";
import { useAppConfig } from "./config.js";

export class SavePath {
  readonly prefix = getDateTimeString();
  private seq = 1;

  get sequence() {
    return this.seq.toString().padStart(4, "0");
  }

  updateSequence(s: string) {
    if (!/\d+/.test(s)) return;
    this.seq = parseInt(s) + 1;
  }

  get directory() {
    return `${this.prefix}.${this.namespace}`;
  }

  private __last_save_path = ref<string | null>(null);
  // `existsSync`/`homedir` aren't reachable from the renderer once
  // contextIsolation is on, so the default resolves asynchronously via
  // `foveaBridge` (docs/history/refactor/orchestrator.md §7.1 T5) — starts empty,
  // filled in shortly after construction (usually well under the time it
  // takes a user to open the save dialog).
  private __default_path = ref<string>("");

  get default_path() {
    return this.__default_path.value;
  }

  get current_path() {
    return this.__last_save_path.value ?? this.default_path;
  }

  set current_path(path: string) {
    path = path.trim();
    if (path === "" || path === this.default_path)
      this.__last_save_path.value = null;
    else this.__last_save_path.value = path;
  }

  resetPath() {
    this.__last_save_path.value = null;
  }

  constructor(public readonly namespace: string) {
    // The default resolves through main (external volume / ~/Downloads), now
    // honoring the user's configured base dir (`AppConfig.default_save_dir`)
    // when set. Read once at construction — a later change applies to the next
    // capture/record control that mounts (a fresh `SavePath`), not this live
    // one. `useAppConfig` needs the store; degrade to no base if unavailable.
    void (async () => {
      let base: string | undefined;
      try {
        base = (await useAppConfig()).default_save_dir || undefined;
      } catch {
        base = undefined;
      }
      this.__default_path.value = await window.foveaBridge.resolveDefaultSavePath(
        this.directory,
        base,
      );
    })();
  }
}
