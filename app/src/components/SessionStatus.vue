<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<script setup lang="ts">
import { ref, watch } from "vue";
import { connect } from "@lib/orchestrator/client";
import { topic, type SessionStatus } from "@lib/orchestrator/protocol";

const props = defineProps<{ name: string | null | undefined }>();
const error = ref<string | null>(null);

watch(
  () => props.name,
  (name, _old, onCleanup) => {
    error.value = null;
    if (!name) return;
    let cancelled = false;
    let cleanup = () => {};
    onCleanup(() => {
      cancelled = true;
      cleanup();
    });
    void connect().then((ch) => {
      if (cancelled) return;
      const subscription = { name, passive: true };
      ch.emit(topic.subscribe, subscription);
      const off = ch.on(topic.status(name), (status: SessionStatus) => {
        error.value = status.error;
      });
      cleanup = () => {
        off();
        ch.emit(topic.unsubscribe, subscription);
      };
    });
  },
  { immediate: true },
);
</script>

<template>
  <p v-if="error" class="session-error" role="alert">
    {{ error }}
  </p>
</template>

<style scoped lang="scss">
/* Shares the one app error identity (P2): --danger family, instantly visible
   (no fade), role="alert". */
.session-error {
  margin: 0.5em auto;
  max-width: 60ch;
  padding: 0.5em 1ch;
  border-radius: 0.5em;
  background: var(--danger-bg);
  border: 1px solid var(--danger-strong);
  color: var(--danger-text);
  text-align: center;
  font-size: 0.9em;
}
</style>
