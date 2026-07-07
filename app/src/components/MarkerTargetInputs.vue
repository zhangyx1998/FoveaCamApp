<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<script setup lang="ts">
import ConfigEntry from "./ConfigEntry.vue";
import type { Session } from "@lib/orchestrator/client";

type Role = "L" | "C" | "R";

const props = withDefaults(
  defineProps<{
    session: Session<any>;
    role: Role;
    detected?: boolean;
    width?: string;
  }>(),
  { detected: false, width: undefined },
);

function setTargetId(e: Event): void {
  const id = Number((e.target as HTMLInputElement).value);
  void props.session.call("setTargetId", { role: props.role, id });
}
</script>

<template>
  <ConfigEntry>
    <span>{{ detected ? "✓" : "✗" }} Marker ID to Track:</span>
    <input
      type="number"
      step="1"
      :style="width ? { width } : undefined"
      :value="session.state.target_id[role]"
      @change="setTargetId"
    />
  </ConfigEntry>
</template>
