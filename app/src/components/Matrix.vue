<!-- ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 --------------------------------------------------------- -->
<script setup lang="ts">
import { Mat } from "core/Vision";
import { computed } from "vue";
const props = defineProps<{ mat: Mat; round?: number }>();
const h = computed(() => props.mat.shape[0] ?? 0);
const w = computed(() => props.mat.shape[1] ?? 0);
const rows = computed(() => Array.from({ length: h.value }, (_, i) => i));
const cols = computed(() => Array.from({ length: w.value }, (_, i) => i));
function plusSign(v: string) {
  return v.startsWith("-") ? v : "+" + v;
}
function format(v?: number | bigint) {
  if (props.round === undefined) return plusSign(v?.toString() ?? "--");
  if (typeof v === "bigint") return plusSign(v.toString());
  return plusSign(v?.toFixed(props.round) ?? "--");
}
</script>

<template>
  <table class="matrix">
    <tr class="row" v-for="j in rows" :key="j">
      <td class="cell" v-for="i in cols" :key="i">
        {{ format(props.mat.at(j * w + i)) }}
      </td>
    </tr>
  </table>
</template>

<style scoped lang="scss">
.matrix {
  border: 1px solid #ccc;
  .row {
    .cell {
      //   width: 2em;
      //   height: 2em;
      //   line-height: 2em;
      text-align: right;
      padding: 0.2em 0.5em;
      border: 1px solid #eee;
      font-family: monospace;
    }
  }
}
</style>
