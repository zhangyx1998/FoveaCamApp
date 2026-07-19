// The marker Dictionary picker's v-model contract: the functional component
// must bind both the <select>'s value and a change handler (and declare the
// props/emits so ctx.emit can dispatch), so the dictionary is not pinned to the
// contract default. These tests pin the contract at the vnode level (no DOM needed).

import { describe, expect, it, vi } from "vitest";
import type { VNode } from "vue";
import { DictionaryTypeSelector } from "@modules/calibrate-intrinsic/dictionary-selector";
import type { PreDefinedDictionary } from "core/Vision";

function render(modelValue: PreDefinedDictionary, emit = vi.fn()): {
  vnode: VNode;
  emit: ReturnType<typeof vi.fn>;
} {
  const vnode = (DictionaryTypeSelector as unknown as (
    props: { modelValue: PreDefinedDictionary },
    ctx: { attrs: Record<string, unknown>; emit: typeof emit; slots: {} },
  ) => VNode)({ modelValue }, { attrs: {}, emit, slots: {} });
  return { vnode, emit };
}

describe("DictionaryTypeSelector (v-model wiring)", () => {
  it("binds the select's value to modelValue and marks the option selected", () => {
    const { vnode } = render("APRILTAG_36h11");
    expect(vnode.props?.value).toBe("APRILTAG_36h11");
    const options = vnode.children as VNode[];
    const selected = options.filter((o) => o.props?.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.props?.value).toBe("APRILTAG_36h11");
  });

  it("emits update:modelValue with the chosen dictionary on change", () => {
    const { vnode, emit } = render("4X4_50");
    const onChange = vnode.props?.onChange as (e: Event) => void;
    expect(typeof onChange).toBe("function");
    onChange({ target: { value: "APRILTAG_16h5" } } as unknown as Event);
    expect(emit).toHaveBeenCalledWith("update:modelValue", "APRILTAG_16h5");
  });

  it("declares props + emits (a functional component can't emit without them)", () => {
    expect(DictionaryTypeSelector.props).toContain("modelValue");
    expect(DictionaryTypeSelector.emits).toContain("update:modelValue");
  });

  it("offers the full dictionary set including the AprilTag families", () => {
    const { vnode } = render("4X4_50");
    const values = (vnode.children as VNode[]).map((o) => o.props?.value);
    expect(values).toContain("APRILTAG_36h11");
    expect(values).toContain("ARUCO_ORIGINAL");
    expect(values.length).toBe(22);
  });
});
