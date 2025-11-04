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

    :deep(select) {
        display: inline-block;
        font-family: inherit;
        font-size: inherit;
        outline: 1px solid #666;
        border: none;
        background: none;
        border-radius: 4px;
        padding: 0.2em 1ch;
        color: inherit;
        &:focus {
            outline: 1px solid #08c;
        }
    }
}
</style>
