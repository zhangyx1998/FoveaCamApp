// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { ref } from "vue";

export class FreqMeter {
    private readonly freq = ref(0);
    private lastTick = performance.now();
    constructor(
        public readonly decay: number = 0.9,
        public readonly digits: number = 2
    ) {}
    public get value() {
        return this.freq.value;
    }
    public toString() {
        return this.value.toFixed(this.digits);
    }
    public tick() {
        const now = performance.now();
        const mea = 1000.0 / (now - this.lastTick);
        this.freq.value =
            this.freq.value * this.decay + mea * (1.0 - this.decay);
        this.lastTick = now;
    }
}

export class PerfTimer {
    private readonly perf = ref(0);
    constructor(
        public readonly decay: number = 0.9,
        public readonly digits: number = 2
    ) {}
    public measure<T>(fn: () => T): T {
        const start = performance.now();
        const result = fn();
        if (result instanceof Promise) {
            return result.then((res) => {
                const end = performance.now();
                const mea = end - start;
                this.perf.value =
                    this.perf.value * this.decay + mea * (1.0 - this.decay);
                return res;
            }) as unknown as T;
        }
        const end = performance.now();
        const mea = end - start;
        this.perf.value =
            this.perf.value * this.decay + mea * (1.0 - this.decay);
        return result;
    }
    public toString() {
        return this.perf.value.toFixed(this.digits);
    }
}
