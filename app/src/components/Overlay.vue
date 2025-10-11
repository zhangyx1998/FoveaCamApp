<script setup lang="ts">
import { computed, useTemplateRef, type PropType } from 'vue';
import { ElementSize } from '@lib/util/dom';
const props = defineProps({
    type: {
        type: String as PropType<"persistent" | "hover-only">,
        required: false,
        default: "persistent"
    },
    display: {
        type: String as PropType<"block" | "inline-block" | "inline" | "flex" | "inline-flex" | "grid" | "inline-grid">,
        required: false,
        default: "block"
    },
    // When `show` is provided (not null), overrides `type`
    show: {
        type: Boolean,
        required: false,
        default: null
    },
    fontSize: {
        type: Number,
        required: false,
        default: null
    },
    pointerEvents: {
        type: Boolean,
        required: false,
        default: true
    },
    userSelect: {
        type: Boolean,
        required: false,
        default: false
    },
})
const overlay = useTemplateRef<HTMLDivElement>("overlay");
const size = new ElementSize(overlay);
const style = computed(() => {
    const style = {} as Record<string, string>;
    if (props.fontSize !== null && size.width) {
        style['fontSize'] = `${props.fontSize * size.width / 100}px`;
    }
    if (!props.pointerEvents) style['pointerEvents'] = 'none';
    if (!props.userSelect) style['userSelect'] = 'none';
    if (props.show === true) {
        style['display'] = props.display;
    } else if (props.show === false) {
        style['display'] = 'none';
    } else if (props.type === "persistent") {
        style['display'] = props.display;
    }
    return style;
})
const classes = computed(() => {
    return {
        'hover-only': props.show === null && props.type === "hover-only"
    };
});
</script>

<template>
    <div class="overlay" :class="classes" ref="overlay" :style="style">
        <slot></slot>
    </div>
</template>

<style scoped lang="scss">
.overlay {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 100%;
    height: 100%;
    padding: 1em;
    box-sizing: border-box;

    :not(:hover)>&.hover-only {
        opacity: 0;
        pointer-events: none !important;
    }
}
</style>
