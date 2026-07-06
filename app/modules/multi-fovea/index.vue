<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<script setup lang="ts">
import { useSession } from "@lib/orchestrator/client";
import { multiFovea } from "./contract";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import RangeSlider from "@src/inputs/range-slider.vue";

const session = useSession(multiFovea, "multi-fovea");
const { state, telemetry } = session;
const center = session.frame("C");

function setTargetEnabled(index: number, enabled: boolean): void {
  const next = state.targets.slice();
  next[index] = { ...next[index], enabled };
  state.targets = next;
}

function onTargetEnabled(index: number, event: Event): void {
  setTargetEnabled(index, (event.target as HTMLInputElement).checked);
}

function targetFrame(index: number) {
  return session.frame(`fovea:${index}`);
}

async function captureOnce(): Promise<void> {
  const result = await session.call("captureOnce", undefined);
  if (!result.ok) console.warn(`[multi-fovea] capture rejected: ${result.reason}`);
}
</script>

<template>
  <div class="multi-fovea">
    <section class="overview">
      <StreamView
        class="center"
        title="Center Overview"
        :payload="center"
        theme="#0af"
        inspector
      />
      <div class="controls">
        <div class="status">
          <span :class="{ live: telemetry.ready }">ready</span>
          <span :class="{ live: telemetry.v2Capable }">v2</span>
          <span>{{ telemetry.captureRejected }}</span>
        </div>
        <label>
          Pulse
          <RangeSlider v-model="state.pulse_ns" :min="100000" :max="10000000" :step="100000" />
        </label>
        <button @click="captureOnce">Capture</button>
        <button @click="session.call('resetTargets', undefined)">Reset</button>
      </div>
    </section>

    <section class="targets">
      <article v-for="(target, index) in state.targets" :key="index" class="target">
        <header>
          <label>
            <input
              type="checkbox"
              :checked="target.enabled"
              @change="onTargetEnabled(index, $event)"
            />
            Target {{ index + 1 }}
          </label>
          <span>stream {{ telemetry.targets[index]?.streamId ?? "-" }}</span>
        </header>
        <div class="target-body">
          <StreamView
            title="Fovea"
            :payload="targetFrame(index).value"
            theme="#fa0"
            height="14rem"
          />
          <PosView
            :pos="telemetry.targets[index]?.volt.L ?? { x: 0, y: 0 }"
            color="#0af"
            style="width: 100%"
          />
        </div>
        <footer>
          <span>lost {{ telemetry.targets[index]?.lostCount ?? 0 }}</span>
          <span>{{ (telemetry.targets[index]?.streamHz ?? 0).toFixed(1) }} Hz</span>
          <span>{{ telemetry.targets[index]?.lastFinAgeMs?.toFixed(0) ?? "-" }} ms</span>
        </footer>
      </article>
    </section>
  </div>
</template>

<style scoped lang="scss">
.multi-fovea {
  display: grid;
  grid-template-rows: minmax(20rem, 1fr) auto;
  gap: 1rem;
  padding: 1rem;
  min-height: 100%;
  box-sizing: border-box;
  background: #161616;
  color: #ddd;
}

.overview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 18rem;
  gap: 1rem;
  min-height: 0;
}

.center {
  min-height: 18rem;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem;
  background: #202020;
  border: 1px solid #333;
  border-radius: 6px;
}

.status {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;

  span {
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    background: #333;
    color: #aaa;

    &.live {
      background: #064;
      color: white;
    }
  }
}

button {
  border: 1px solid #555;
  border-radius: 4px;
  background: #292929;
  color: inherit;
  padding: 0.45rem 0.65rem;
  cursor: pointer;
}

.targets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: 1rem;
}

.target {
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem;
  background: #202020;
  border: 1px solid #333;
  border-radius: 6px;

  header,
  footer {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    color: #aaa;
    font-size: 0.85rem;
  }
}

.target-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 5rem;
  gap: 0.5rem;
  align-items: center;
}
</style>
