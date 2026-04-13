// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { resolve } from "node:path";
import { homedir } from "node:os";
import { ref } from "vue";
import { getDateTimeString } from "./util/string";

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

  get default_path() {
    return resolve(homedir(), "Downloads", this.directory);
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

  constructor(public readonly namespace: string) {}
}
