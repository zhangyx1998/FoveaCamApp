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
    private lastTick = performance.now();
    constructor(
        decay: number = 0.9,
        digits: number = 2,
        unit: string | null = "Hz"
    ) {
        super(decay, digits, unit);
    }
    public tick() {
        const now = performance.now();
        const mea = 1000.0 / (now - this.lastTick);
        this.roll(mea);
        this.lastTick = now;
    }
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
