// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { computed, markRaw, ref, shallowRef, watch } from "vue";
import { Log, Vision } from "core";
import type { Camera, Frame } from "core/Aravis";
import {
    MarkerDetector,
    type Mat,
    type MarkerDetectResult,
    type MarkerDetectResults,
} from "core/Vision";
import { Point2d, Point3d, Size } from "core/Geometry";
import type { Controller, Pos } from "@src/components/Controller.vue";
import { clamp, delay } from "@lib/util/index.js";
import { avg } from "@lib/util/math.js";
import abortable from "@lib/abortable.js";
import { FreqMeter } from "@lib/util/perf.js";
import {
    bilinearInterpolate,
    CORNER_OBJ_POINTS,
    getInternalObjectPoints,
} from "@lib/marker.js";

export async function record(
    detector: MarkerDetector,
    result: MarkerDetectResult,
    frame?: Mat<Uint8Array>,
    internal: boolean = true
) {
    const img_points = [...result];
    const obj_points = [...CORNER_OBJ_POINTS];
    if (frame && internal) {
        const internal_obj_points = Array.from(
            getInternalObjectPoints(detector.pattern(result.id))
        );
        obj_points.push(...internal_obj_points);
        const internal_img_points = bilinearInterpolate(
            result,
            internal_obj_points
        );
        img_points.push(
            ...(await Vision.cornerSubPix(frame, internal_img_points))
        );
    }
    return { img_points, obj_points };
}

export type TrackerRecord = Awaited<ReturnType<typeof record>>;

export default class Tracker extends EventTarget {
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
    private readonly __target__ = shallowRef<MarkerDetectResult | null>(null);
    get target() {
        return this.__target__.value;
    }
    private readonly __center_relative__ = computed(() => {
        const { value } = this.__target__;
        if (!value) return value;
        const { width, height } = value;
        return {
            x: avg(...value.map((p) => p.x)) / width - 0.5,
            y: avg(...value.map((p) => p.y)) / height - 0.5,
        };
    });
    get center_relative() {
        return this.__center_relative__.value;
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
    private readonly __other_targets__ = shallowRef<MarkerDetectResult[]>([]);
    get other_targets() {
        return this.__other_targets__.value;
    }
    private handleDetections(detections: MarkerDetectResults) {
        const { target_id } = this;
        let target: MarkerDetectResult | null = null;
        const others: MarkerDetectResult[] = [];
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
        public readonly detector: MarkerDetector = new MarkerDetector("4X4_50"),
        target_id: number = 0,
        scale: number = 1.0
    ) {
        super();
        this.target_id = target_id;
        this.task = abortable(async (aborted) => {
            try {
                if (!camera) return;
                for (const detections of detector.stream(
                    camera.stream,
                    scale
                )) {
                    if (aborted()) break;
                    if (detections !== null) {
                        Log.verbose(
                            "Got",
                            detections.length,
                            "detections for",
                            detections.frame.toString()
                        );
                        this.fps.tick();
                        this.dispatchEvent(new Event("detection"));
                        this.handleDetections(detections);
                    } else {
                        await new Promise((r) => setImmediate(r));
                    }
                }
            } catch (e) {
                console.error("Detection error:", e);
            }
        });
    }
}

function backToCenter(p: number, kp: number) {
    return -clamp(Math.sign(p) * kp, [Math.min(0, p), Math.max(0, p)]);
}

export function actuate(
    controller: Controller,
    left: Tracker | undefined,
    right: Tracker | undefined,
    config: { kp?: number; origin_left?: Point2d; origin_right?: Point2d } = {}
) {
    return abortable(async (aborted) => {
        if (!controller) return;
        const pending: { left?: Pos; right?: Pos } = {};
        left?.addEventListener("detection", () => {
            const c = left.center_relative;
            const { kp = 16.0 } = config;
            const { x, y } = controller.pos.left;
            if (c) {
                const { x: dx, y: dy } = c;
                pending.left = {
                    x: x + dx * kp,
                    y: y + dy * kp,
                };
            } else {
                const origin = config.origin_left ?? { x: 0, y: 0 };
                pending.left = {
                    x: x + backToCenter(x - origin.x, kp),
                    y: y + backToCenter(y - origin.y, kp),
                };
            }
        });
        right?.addEventListener("detection", () => {
            const c = right.center_relative;
            const { kp = 16.0 } = config;
            const { x, y } = controller.pos.right;
            if (c) {
                const { x: dx, y: dy } = c;
                pending.right = {
                    x: x + dx * kp,
                    y: y + dy * kp,
                };
            } else {
                const origin = config.origin_right ?? { x: 0, y: 0 };
                pending.right = {
                    x: x + backToCenter(x - origin.x, kp),
                    y: y + backToCenter(y - origin.y, kp),
                };
            }
        });
        try {
            await controller.enable();
            await controller.actuate({
                left: config.origin_left ?? { x: 0, y: 0 },
                right: config.origin_right ?? { x: 0, y: 0 },
            });
            while (!aborted()) {
                if (pending.left || pending.right) {
                    await controller.actuate(pending);
                    delete pending.left;
                    delete pending.right;
                } else await new Promise((r) => setImmediate(r));
            }
        } finally {
            await controller.disable();
        }
    });
}
