<template>
    <div class="config-entry">
        <slot></slot>
    </div>
</template>

<style lang="scss" scoped>
.config-entry {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1.5px solid transparent;
    border-bottom: 1.5px solid transparent;

    & > * {
        text-wrap: nowrap;
    }

    &:hover {
        border-bottom: 1.5px solid #fff4;
    }

    &:focus-within {
        border-bottom: 1.5px solid #fff8;
    }

    margin: 0.4em 0;

    :deep(input) {
        text-align: center;
        background: none;
        border: 1.5px solid transparent;
        color: #ccc;
        outline: none !important;
        font-size: inherit;
        font-family: inherit;
    }
}
</style>
