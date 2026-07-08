// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { ref } from "vue";

export class RollingAverage {
    private init = true;
    private readonly __value__ = ref(0);
    get value() {
        return this.__value__.value;
    }
    constructor(
        public readonly decay: number = 0.9,
        private readonly digits: number = 2,
        private readonly unit: string | null = null
    ) {}
    public roll(v: number) {
        if (this.init) {
            this.__value__.value = v;
            this.init = false;
        } else {
            this.__value__.value =
                this.__value__.value * this.decay + v * (1.0 - this.decay);
        }
    }
    public reset(v: number | null = null) {
        if (v === null) {
            this.init = true;
            this.__value__.value = 0;
        } else {
            this.__value__.value = v;
        }
    }
    public toString() {
        const ret = this.value.toFixed(this.digits);
        if (this.unit) return ret + " " + this.unit;
        else return ret;
    }
}

export class FreqMeter extends RollingAverage {
    private lastTick: number | null = null;
    constructor(
        decay: number = 0.9,
        digits: number = 2,
        unit: string | null = "Hz"
    ) {
        super(decay, digits, unit);
    }
    public tick() {
        const now = performance.now();
        if (this.lastTick !== null) this.roll(now - this.lastTick);
        this.lastTick = now;
    }
    public get value() {
        return super.value === 0 ? 0 : 1000 / super.value;
    }
    public reset(v: number | null = null) {
        super.reset(v);
        this.lastTick = null;
    }
}

// Global inspector toggle for the frame-transport OSD (docs/history/refactor/
// orchestrator.md roadmap item 3). Ctrl+Shift+I flips it in any renderer
// window; `StreamView` shows the extra profiling lines when it (or its own
// `inspector` prop) is on. Kept here rather than a new file since it's the
// same "profiling display" concern as the meters above.
export const inspectorMode = ref(false);
if (typeof window !== "undefined") {
    window.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "i") {
            inspectorMode.value = !inspectorMode.value;
        }
    });
}

export class PerfTimer extends RollingAverage {
    constructor(
        decay: number = 0.9,
        digits: number = 2,
        unit: string | null = "ms"
    ) {
        super(decay, digits, unit);
    }
    public measure<T>(fn: () => T): T {
        const start = performance.now();
        const result = fn();
        if (result instanceof Promise) {
            return result.then((res) => {
                const end = performance.now();
                const mea = end - start;
                this.roll(mea);
                return res;
            }) as unknown as T;
        } else {
            const end = performance.now();
            const mea = end - start;
            this.roll(mea);
            return result;
        }
    }
}
