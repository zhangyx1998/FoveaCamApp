// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// ArUco/AprilTag dictionary picker. Lives here (next to its only consumer)
// rather than in `@lib/marker` so that the pure marker math stays free of any
// `vue` import — the orchestrator's calibration loader pulls `@lib/marker`, and
// a `vue` dependency there would bundle Vue into the utility process.

import { FunctionalComponent, h } from "vue";
import type { PreDefinedDictionary } from "core/Vision";

const options = [
  "4X4_50",
  "4X4_100",
  "4X4_250",
  "4X4_1000",
  "5X5_50",
  "5X5_100",
  "5X5_250",
  "5X5_1000",
  "6X6_50",
  "6X6_100",
  "6X6_250",
  "6X6_1000",
  "7X7_50",
  "7X7_100",
  "7X7_250",
  "7X7_1000",
  "ARUCO_ORIGINAL",
  "APRILTAG_16h5",
  "APRILTAG_25h9",
  "APRILTAG_36h10",
  "APRILTAG_36h11",
  "ARUCO_MIP_36h12",
] as const;

// v-model-capable: a functional component must declare `props`/`emits` for
// `ctx.emit` to dispatch, and a native <select> needs the `value` DOM prop +
// a `change` listener wired by hand.
export const DictionaryTypeSelector: FunctionalComponent<
  { modelValue: PreDefinedDictionary },
  { "update:modelValue": (value: PreDefinedDictionary) => void }
> = (props, ctx) => {
  return h(
    "select",
    {
      ...ctx.attrs,
      value: props.modelValue,
      onChange: (e: Event) =>
        ctx.emit(
          "update:modelValue",
          (e.target as HTMLSelectElement).value as PreDefinedDictionary,
        ),
    },
    options.map((k) => h("option", { value: k, selected: k === props.modelValue }, k)),
  );
};
DictionaryTypeSelector.props = ["modelValue"];
DictionaryTypeSelector.emits = ["update:modelValue"];
