<script setup lang="ts">
import { shallowRef } from "vue";
import Calibrate from "./calibrate.vue";
import Finalize from "./finalize.vue";
import { ExtrinsicRecord } from "./record";
const records = shallowRef<ExtrinsicRecord[] | null>(null);
</script>

<template>
    <component v-if="records === null" :is="Calibrate" />
    <component v-else :is="Finalize" :records="records" />
</template>
