// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { computed, markRaw, ref, shallowRef, watch } from "vue";
import type {
    ArUcoDetectResult,
    ArUcoDetectResults,
    Camera,
    Frame,
    Mat,
} from "core";
import { ArUcoDetector } from "core";
import { clamp, delay } from "@lib/util";
import type { Controller, Pos } from "@src/components/Controller.vue";
import { avg } from "@lib/util/math";
import abortable from "@lib/abortable";
import { FreqMeter } from "@lib/util/perf";

export type TrackerRecord = {
    gray: Mat<Uint8Array>;
    rgba: Mat<Uint8Array>;
    detection: ArUcoDetectResult;
};

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
        const { width, height } = value;
        return {
            x: avg(...value.map((p) => p.x)) / width - 0.5,
            y: avg(...value.map((p) => p.y)) / height - 0.5,
        };
    });
    get center() {
        return this.__center__.value;
    }
    private readonly __center_absolute__ = computed(() => {
        const { value } = this.__target__;
        if (!value) return value;
        const { width, height } = value;
        return {
            x: avg(...value.map((p) => p.x)),
            y: avg(...value.map((p) => p.y)),
            width,
            height,
        };
    });
    get center_absolute() {
        return this.__center_absolute__.value;
    }
    private readonly __frame__ = shallowRef<Frame | null>(null);
    get frame() {
        return this.__frame__.value;
    }
    private readonly __other_targets__ = shallowRef<ArUcoDetectResult[]>([]);
    get other_targets() {
        return this.__other_targets__.value;
    }
    private handleDetections(detections: ArUcoDetectResults) {
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
        this.__frame__.value = detections.frame;
    }
    constructor(
        public readonly camera: Camera,
        public readonly detector: ArUcoDetector = new ArUcoDetector("4X4_50"),
        target_id: number = 0,
        scale: number = 1.0
    ) {
        this.target_id = target_id;
        watch(this.__frame__, (_, prev) => prev?.release());
        this.task = abortable(async (aborted) => {
            try {
                if (!camera) return;
                for (const detections of detector.stream(
                    camera.stream,
                    scale
                )) {
                    if (aborted()) break;
                    if (detections !== null) {
                        this.fps.tick();
                        this.handleDetections(detections);
                    }
                    await delay(1);
                }
            } catch (e) {
                console.error("Detection error:", e);
            } finally {
                this.__frame__.value = null;
            }
        });
    }
    get isRecordable() {
        return this.target !== null && this.frame !== null;
    }
    async record<T extends Record<string, unknown> = {}>(
        mixin?: T
    ): Promise<TrackerRecord & T> {
        const { target, frame: borrowed } = this;
        if (!target || !borrowed) throw new Error("No target to record");
        const frame = borrowed.ref();
        const record: TrackerRecord & T = {
            gray: await frame.view("Mono8"),
            rgba: await frame.view("BGRA8"),
            detection: target,
            ...(mixin ?? ({} as T)),
        };
        frame.release();
        return markRaw(record) as TrackerRecord & T;
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
