<script setup lang="ts">
import ElementSize from "@lib/element-size";
import { useTemplateRef } from "vue";

const emit = defineEmits<{
    (e: "back"): void;
}>();
const bar = useTemplateRef<HTMLElement>("nav-back");
const size = new ElementSize(bar);
</script>

<template>
    <div class="nav-back" ref="nav-back">
        <button class="nav-back-button">
            <svg
                viewBox="0 0 32 32"
                style="width: 1em; height: 1em"
                @click="emit('back')"
            >
                <path
                    d="M4 16h24M16 4l-12 12 12 12"
                    stroke="currentColor"
                    stroke-width="4"
                />
            </svg>
        </button>
        <slot></slot>
    </div>
</template>

<style scoped>
.nav-back {
    display: flex;
    flex-direction: row;
    width: 100%;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3em;
    background-color: var(--bg-app);
    justify-content: flex-start;
    align-items: center;
    border-bottom: 1px solid var(--border-muted);
    & > :deep(*) {
        margin: 0.5em 1em;
    }
    .nav-back-button {
        background: none;
        border: none;
        color: inherit;
        cursor: pointer;
        display: flex;
        justify-content: center;
        align-items: center;
        font-size: inherit;
        padding: 1em;
        margin: 0;
        &:hover {
            background-color: var(--tint-3);
        }
    }
}
</style>
