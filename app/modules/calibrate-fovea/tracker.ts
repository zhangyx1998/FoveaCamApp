// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { computed, ref, shallowRef, watch } from "vue";
import type { ArUcoDetectResult, Camera } from "core";
import { ArUcoDetector } from "core";
import { clamp, delay } from "@lib/util";
import type { Controller, Pos } from "@src/components/Controller.vue";
import { avg } from "@lib/util/math";
import abortable from "@lib/abortable";
import { FreqMeter, PerfTimer } from "@lib/util/perf";

export default class Tracker {
    public readonly fps = new FreqMeter();
    public readonly task: ReturnType<typeof abortable>;
    public readonly __target_id__ = ref<number>(0);
    get target_id() {
        return this.__target_id__.value;
    }
    set target_id(v: number) {
        this.__target_id__.value = v;
    }
    private lost_count = 0;
    private readonly __target__ = shallowRef<ArUcoDetectResult | null>(null);
    get target() {
        return this.__target__.value;
    }
    private readonly __center__ = computed(() => {
        const { value } = this.__target__;
        if (!value) return value;
        return {
            x: avg(...value.map((p) => p.x)) / value.w - 0.5,
            y: avg(...value.map((p) => p.y)) / value.h - 0.5,
        };
    });
    get center() {
        return this.__center__.value;
    }
    private readonly __other_targets__ = shallowRef<ArUcoDetectResult[]>([]);
    get other_targets() {
        return this.__other_targets__.value;
    }
    private handleDetections(detections: ArUcoDetectResult[]) {
        const { target_id } = this;
        let target: ArUcoDetectResult | null = null;
        const others: ArUcoDetectResult[] = [];
        for (const d of detections) {
            if (target === null && d.id === target_id) target = d;
            else others.push(d);
        }
        if (target !== null) {
            this.__target__.value = target;
            this.lost_count = 0;
        } else {
            this.lost_count++;
            if (this.lost_count >= 5) this.__target__.value = null;
        }
        this.__other_targets__.value = others;
    }
    constructor(
        public readonly camera: Camera,
        public readonly detector: ArUcoDetector = new ArUcoDetector("4X4_50"),
        target_id: number = 0,
        scale: number = 1.0
    ) {
        this.target_id = target_id;
        this.task = abortable(async (aborted) => {
            try {
                if (!camera) return;
                const stream = detector.stream(camera.stream, scale);
                for (const detections of stream) {
                    if (aborted()) break;
                    if (detections !== null) {
                        this.fps.tick();
                        this.handleDetections(detections);
                    }
                    await delay(1);
                }
            } catch (e) {
                console.error("Detection error:", e);
            }
        });
    }
}

function backToCenter(p: number, kp: number, dt: number) {
    return -clamp(Math.sign(p) * kp * dt, [Math.min(0, p), Math.max(0, p)]);
}

export function actuate(
    controller: Controller,
    left: Tracker | undefined,
    right: Tracker | undefined,
    kp = 1e3
) {
    return abortable(async (aborted) => {
        if (!controller) return;
        const pending: { left?: Pos; right?: Pos } = {};
        const handles = [
            watch(
                () => left?.center,
                (c) => {
                    const dt = 1 / Math.max(10, left?.fps?.value ?? 0);
                    const { x, y } = controller.pos.left;
                    if (c) {
                        const { x: dx, y: dy } = c;
                        pending.left = {
                            x: x + dx * kp * dt,
                            y: y + dy * kp * dt,
                        };
                    } else {
                        pending.left = {
                            x: x + backToCenter(x, kp, dt),
                            y: y + backToCenter(y, kp, dt),
                        };
                    }
                }
            ),
            watch(
                () => right?.center,
                (c) => {
                    const dt = 1 / Math.max(10, right?.fps?.value ?? 0);
                    const { x, y } = controller.pos.right;
                    if (c) {
                        const { x: dx, y: dy } = c;
                        pending.right = {
                            x: x + dx * kp * dt,
                            y: y + dy * kp * dt,
                        };
                    } else {
                        pending.right = {
                            x: x + backToCenter(x, kp, dt),
                            y: y + backToCenter(y, kp, dt),
                        };
                    }
                }
            ),
        ];
        try {
            await controller.enable();
            while (!aborted()) {
                if (pending.left || pending.right) {
                    await controller.actuate(pending);
                    delete pending.left;
                    delete pending.right;
                } else await delay(1);
            }
        } finally {
            await controller.disable();
            for (const h of handles) h.stop();
        }
    });
}
