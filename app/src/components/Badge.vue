<script setup lang="ts">
defineProps<{
    color?: string;
    solid?: boolean;
}>();
</script>

<template>
    <div
        class="badge"
        :class="{ solid }"
        :style="{ '--theme': color ?? 'gray' }"
    >
        <slot></slot>
    </div>
</template>

<style scoped lang="scss">
.badge {
    display: inline-block;
    padding: 0.2em 0.3em;
    border-radius: 0.3em;
    font-size: 0.8em;
    font-weight: normal;
    color: var(--theme);
    border: 1.5px solid var(--theme);
    &.solid {
        background-color: var(--theme);
        color: black;
    }
}
</style>
