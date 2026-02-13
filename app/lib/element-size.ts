/* ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 * --------------------------------------------------------- */

import { ref, ShallowRef, watch } from "vue";

export default class ElementSize {
  #width = ref(0);
  get width() {
    return this.#width.value;
  }

  #height = ref(0);
  get height() {
    return this.#height.value;
  }

  private readonly listener: () => void;
  constructor(private el: Readonly<ShallowRef<HTMLElement | null>>) {
    this.listener = () => this.update();
    window.addEventListener("update-size", this.listener);
    watch(el, () => this.update(), { immediate: true });
  }

  update() {
    const el = this.el.value;
    if (el === null) return;
    this.#width.value = el.getBoundingClientRect().width;
    this.#height.value = el.getBoundingClientRect().height;
  }

  destroy() {
    window.removeEventListener("update-size", this.listener);
  }

  static notify() {
    window.dispatchEvent(new Event("update-size"));
  }
}

window.addEventListener("resize", ElementSize.notify);
window.setInterval(ElementSize.notify, 200);
