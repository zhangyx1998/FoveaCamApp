<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  SVG annotation canvas (docs/refactor/multi-window.md req. 5 / §4): a plain
  SVG layer stretched over the live preview. Annotations are slotted-in
  `<Annotation>` elements — one annotation per element, stable ids, x/y in
  percent of the preview area — so the USER can hand-position them by editing
  the parent template's markup directly. Deliberately no layout logic here.
-->
<script setup lang="ts"></script>

<template>
  <svg
    class="annotation-canvas"
    viewBox="0 0 100 100"
    preserveAspectRatio="none"
  >
    <slot></slot>
  </svg>
</template>

<style scoped>
.annotation-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
</style>
