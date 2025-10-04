// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { ref, ShallowRef, watch } from "vue";

export class ElementSize {
    #width = ref(0);
    get width() {
        return this.#width.value;
    }

    #height = ref(0);
    get height() {
        return this.#height.value;
    }

    private readonly listener: () => void;
    constructor(private el: Readonly<ShallowRef<Element | null>>) {
        this.listener = () => this.update();
        window.addEventListener("update-size", this.listener);
        watch(el, () => this.update(), { immediate: true });
    }

    update() {
        if (this.el.value === null) return;
        this.#width.value = this.el.value.getBoundingClientRect().width;
        this.#height.value = this.el.value.getBoundingClientRect().height;
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
