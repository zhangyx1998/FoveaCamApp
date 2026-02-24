/* ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 * --------------------------------------------------------- */

import { onScopeDispose, ref, watch, type ShallowRef } from "vue";

export default class ElementSize {
  #width = ref(0);
  get width() {
    return this.#width.value;
  }

  #height = ref(0);
  get height() {
    return this.#height.value;
  }

  constructor(private el: Readonly<ShallowRef<Element | null>>) {
    watch(el, () => this.update(), { immediate: true });
    ElementSize.subscribe(this);
    onScopeDispose(() => {
      ElementSize.unsubscribe(this);
    });
  }

  update() {
    if (this.el.value === null) return;
    this.#width.value = this.el.value.getBoundingClientRect().width;
    this.#height.value = this.el.value.getBoundingClientRect().height;
  }

  private static readonly instances = new Set<ElementSize>();

  private static subscribe(instance: ElementSize) {
    ElementSize.instances.add(instance);
  }

  private static unsubscribe(instance: ElementSize) {
    ElementSize.instances.delete(instance);
  }

  static notify() {
    for (const instance of ElementSize.instances) instance.update();
  }
}

(async () => {
  while (true) {
    await new Promise((r) => requestAnimationFrame(r));
    ElementSize.notify();
  }
})();
