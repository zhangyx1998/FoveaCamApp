<template>
  <label class="config-entry">
    <slot></slot>
  </label>
</template>

<style lang="scss" scoped>
.config-entry {
  margin: 0.4em 0;
  border-top: 1.5px solid transparent;
  border-bottom: 1.5px solid transparent;

  &,
  & > :deep(label) {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1ch;
  }

  & > * {
    text-wrap: nowrap;
  }

  &:hover {
    border-bottom: 1.5px solid var(--tint-4);
  }

  &:focus-within {
    border-bottom: 1.5px solid var(--tint-8);
  }

  :deep(input) {
    text-align: center;
    background: none;
    border: 1.5px solid transparent;
    color: var(--text-dim);
    outline: none !important;
    font-size: inherit;
    font-family: inherit;
  }

  :deep(select) {
    display: inline-block;
    font-family: inherit;
    font-size: inherit;
    outline: 1px solid var(--border-muted);
    border: none;
    background: none;
    border-radius: 4px;
    padding: 0.2em 1ch;
    color: inherit;
    &:focus {
      outline: 1px solid var(--accent);
    }
  }

  :deep(button) {
    width: 2em;
    height: 2em;
    background: none;
    border: 1px solid transparent;
    color: var(--text-dim);
    cursor: pointer;
    font-size: inherit;
    font-family: inherit;
    padding: 0.2em 0.5em;
    border-radius: 4px;
    &:hover {
      background-color: var(--tint-1);
      color: var(--tint-8);
      border-color: var(--tint-4);
    }
    &:active {
      background-color: var(--tint-2);
      color: #fff9;
      border-color: #fff6;
    }
    & > * {
      width: 100%;
      height: 100%;
      border: none;
    }
  }
}
</style>
