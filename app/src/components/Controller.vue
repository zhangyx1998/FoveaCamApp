<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Title-bar controller indicator. Cutover: the serial MEMS device is now owned by
  the orchestrator process; this is a thin client over the `controller` session.
  The public surface (`getController()`, `connect`, `disconnect`, `Controller`
  and `Pos` types) is preserved so consumers are unchanged.
-->
<script lang="ts">
import { effectScope } from "vue";
import {
  useControllerClient,
  type ControllerFacade,
} from "@lib/controller-client";
import type { Pos } from "@lib/controller-codec";

// Re-export the interface types so existing consumers keep importing them here.
export type { Pos };
export type Controller = ControllerFacade;

// App-lifetime singleton over the orchestrator controller session. A detached
// effect scope keeps its telemetry subscriptions alive for the whole session
// (the title-bar indicator is global and never really unmounts).
let client: ReturnType<typeof useControllerClient> | null = null;
function getClient() {
  if (!client) effectScope(true).run(() => (client = useControllerClient()));
  return client!;
}

/** Same shape as before: the connected controller facade, or null. */
export function getController(): ControllerFacade | null {
  return getClient().controller.value;
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from "vue";
import ElementSize from "@lib/element-size";
import { reportToTray } from "@lib/orchestrator/client";

const client = getClient();
const {
  connected,
  pending,
  vendorId,
  productId,
  connect,
  disconnect,
  canRecoverMems,
  recoverMems,
} = client;
const enabled = computed(() => client.controller.value?.enabled ?? false);

// "Recover mirror" (right-dac-freeze M2): re-init the MEMS DACs in place when a
// driver freezes, without dropping the session. Disabled with a tooltip when
// the system is not enabled or the firmware predates the recovery command.
const recoverState = ref<"idle" | "busy" | "ok">("idle");
const recoverDisabledReason = computed(() => {
  if (!enabled.value) return "Enable the controller first";
  if (!canRecoverMems.value) return "Requires controller firmware ≥ 2.1.0";
  return "";
});
async function onRecoverMirror() {
  if (recoverState.value === "busy" || recoverDisabledReason.value) return;
  recoverState.value = "busy";
  try {
    await recoverMems();
    recoverState.value = "ok";
    setTimeout(() => {
      if (recoverState.value === "ok") recoverState.value = "idle";
    }, 2000);
  } catch (e) {
    recoverState.value = "idle";
    reportToTray(
      "controller",
      `Recover mirror failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

const icon_style = computed(() => {
  if (pending.value) return { "--color": "gray" };
  if (!connected.value) return { "--color": "red" };
  if (!enabled.value) return { "--color": "green" };
  return { "--color": "black", backgroundColor: "cyan" };
});

const indicator = useTemplateRef<HTMLDivElement>("indicator");
const size = new ElementSize(indicator);

onMounted(connect);
</script>

<template>
    <div class="indicator" ref="indicator" :style="icon_style">
        <svg viewBox="0 0 24 24" class="icon">
            <rect
                class="body"
                x="5.29"
                y="5.29"
                width="13.42"
                height="13.42"
                rx="2"
            ></rect>
            <line class="body" x1="7.21" y1="0.5" x2="7.21" y2="5.29"></line>
            <line class="body" x1="12" y1="0.5" x2="12" y2="5.29"></line>
            <line class="body" x1="16.79" y1="0.5" x2="16.79" y2="5.29"></line>
            <line class="body" x1="7.21" y1="18.71" x2="7.21" y2="23.5"></line>
            <line class="body" x1="12" y1="18.71" x2="12" y2="23.5"></line>
            <line
                class="body"
                x1="16.79"
                y1="18.71"
                x2="16.79"
                y2="23.5"
            ></line>
            <line class="body" x1="0.5" y1="16.79" x2="5.29" y2="16.79"></line>
            <line class="body" x1="0.5" y1="12" x2="5.29" y2="12"></line>
            <line class="body" x1="0.5" y1="7.21" x2="5.29" y2="7.21"></line>
            <line
                class="body"
                x1="18.71"
                y1="16.79"
                x2="23.5"
                y2="16.79"
            ></line>
            <line class="body" x1="18.71" y1="12" x2="23.5" y2="12"></line>
            <line class="body" x1="18.71" y1="7.21" x2="23.5" y2="7.21"></line>
            <circle class="dot" cx="15.83" cy="8.17" r="0.96"></circle>
        </svg>
        <div class="dropdown" :style="{ paddingTop: size.height + 'px' }">
            <div class="dropdown-intent">
                <div class="title">Controller Unit</div>
                <div class="config">
                    <span>Vendor ID:</span
                    ><input
                        v-model="vendorId"
                        :disabled="connected || pending"
                    />
                </div>
                <div class="config">
                    <span>Product ID:</span
                    ><input
                        v-model="productId"
                        :disabled="connected || pending"
                    />
                </div>
                <button v-if="!connected" @click="connect" :disabled="pending">
                    Connect
                </button>
                <template v-else>
                    <button
                        class="recover"
                        @click="onRecoverMirror"
                        :disabled="
                            !!recoverDisabledReason || recoverState === 'busy'
                        "
                        :title="
                            recoverDisabledReason ||
                            'Re-initialize the MEMS mirrors without dropping the session'
                        "
                    >
                        <template v-if="recoverState === 'busy'"
                            >Recovering…</template
                        >
                        <template v-else-if="recoverState === 'ok'"
                            >Recovered ✓</template
                        >
                        <template v-else>Recover mirror</template>
                    </button>
                    <button @click="disconnect" :disabled="pending">
                        Disconnect
                    </button>
                </template>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
div.indicator {
    padding: 0.2em;
    border-radius: 0.2em;
    background-color: #0000;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: visible;
    position: relative;

    &:hover {
        outline: 1px solid gray;

        & .dropdown {
            display: flex;
        }
    }

    svg.icon {
        width: 1.2em;
        height: 1.2em;

        .body {
            fill: none;
            stroke: var(--color);
            stroke-miterlimit: 10;
            stroke-width: 1.92px;
        }

        .dot {
            fill: var(--color);
        }
    }

    .dropdown {
        display: none;
        position: absolute;
        z-index: 1000;
        top: 0;
        right: 0;
        background-color: transparent;
        min-width: 20ch;

        .dropdown-intent {
            margin: 0.2em;
            padding: 0.5em;
            background-color: var(--bg-app);
            border: 1px solid var(--border-strong);
            border-radius: 4px;
            color: var(--text);
        }

        .title {
            font-weight: bold;
            margin-bottom: 0.5em;
            border-bottom: 2px solid gray;
        }

        .config {
            font-size: 0.9em;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid transparent;

            & > * {
                text-wrap: nowrap;
            }

            &:focus-within {
                border-bottom: 2px solid gray;
            }

            margin: 0.4em 0;
        }

        input {
            width: 6ch;
            text-align: center;
            background: none;
            border: 2px solid transparent;
            color: var(--text-dim);
            outline: none !important;
            font-size: inherit;
            font-family: inherit;
        }

        .button {
            width: 100%;
            text-align: center;
            margin-top: 0.5em;
        }

        button.recover {
            display: block;
            width: 100%;
            margin-top: 0.5em;
        }
    }
}
</style>
