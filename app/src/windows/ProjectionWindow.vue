<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Projection window (docs/history/refactor/multi-window.md req. 4 / §3): a dedicated
  single-stream viewer, spawned from StreamView's expand button. Windowed by
  default, resizable to fullscreen via the shared chrome (the A-7 titlebar
  fix's stress test).

  Cost/lifecycle contract:
  - Subscribes PASSIVELY (V12) — a viewer must never activate or keep alive
    the source session; it observes telemetry (the `ready` flag) without
    counting toward activation interest.
  - Declares `finterest` on exactly its one frame topic (C10's designed
    payoff) — `useSession().frame(name)` does this on ref creation; no other
    topics are ever opened, so the marginal producer cost is one shm reader.
  - When the source session idles, frames simply stop arriving: the last
    payload stays in the ref (frozen last frame, adopted default §5.3) and a
    subtle overlay notes the source is idle. If the session comes back, the
    stream resumes on its own; V4's frame-cache replay also seeds a
    projection opened after the last publish of a still-active session.

  Contract note: streams are addressed generically (any session, any frame
  channel), so this binds a minimal anonymous contract — empty state, just
  the near-universal `ready` telemetry flag (sessions that don't publish it
  keep the default `true` = no overlay). Frame channels are dynamic and
  contract-independent by design.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useSession } from "@lib/orchestrator/client";
import { defineContract } from "@lib/orchestrator/protocol";
import TitleBar from "../components/TitleBar.vue";
import StreamView from "../components/StreamView.vue";

const props = defineProps<{ session: string; frame: string }>();

const titleBarHeight = ref(0);

// Minimal read-only contract — see the header note.
const projectionContract = defineContract({
  state: {},
  telemetry: { ready: true as boolean },
  frames: [] as const,
  commands: {},
});

const valid = computed(() => !!props.session && !!props.frame);
const source = valid.value
  ? useSession(projectionContract, props.session, { passive: true })
  : null;
const payload = computed(() => source?.frame(props.frame).payload.value ?? null);
const idle = computed(() => !!source && source.telemetry.ready === false);
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <div v-if="!valid" class="notice">
      Missing stream address (?session=…&amp;frame=…)
    </div>
    <template v-else>
      <StreamView
        class="stream"
        :payload="payload"
        :projectable="false"
        width="100%"
        height="100%"
      />
      <div v-if="!payload" class="notice">Waiting for {{ session }} / {{ frame }}…</div>
      <div v-else-if="idle" class="idle-note">source idle — last frame</div>
    </template>
  </div>
  <TitleBar
    title="Projection"
    :subtitle="`${session} / ${frame}`"
    @height="(h) => (titleBarHeight = h)"
  />
</template>

<style scoped lang="scss">
.main {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  * {
    user-select: none;
  }
}

.stream {
  width: 100%;
  height: 100%;
}

.notice {
  color: #888;
  font-size: 1.1em;
  text-align: center;
  padding: 2em;
}

.idle-note {
  position: absolute;
  top: 0.8em;
  right: 1em;
  color: #ccc;
  background: #000a;
  border: 1px solid #fff3;
  border-radius: 3px;
  padding: 0.2em 0.8em;
  font-size: 0.85em;
  pointer-events: none;
}
</style>
