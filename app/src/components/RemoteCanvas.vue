<script lang="ts">
import { computed, Ref, shallowReactive } from "vue";

// Explicit `?url` keeps Vite's default asset handling for this import (the
// svg-loader plugin would otherwise compile a bare `.svg` import into a Vue
// component); typed as string by @zhangyx1998/svg-loader/client.
import SplashDataURL from "./RemoteCanvasSplash.svg?url";

// Parse data url (data:image/svg+xml;base64,...) to get SVG content
function parseDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/svg\+xml(;base64)?,(.*)$/);
  if (!match) {
    throw new Error("Invalid data URL format");
  }
  const isBase64 = !!match[1];
  const data = match[2];
  if (isBase64) {
    return atob(data);
  } else {
    return decodeURIComponent(data);
  }
}

function getInnerSVG(dataUrl: string): string {
  try {
    const svgContent = parseDataUrl(dataUrl);
    return svgContent.replace(/<svg[^>]*>([\s\S]*?)<\/svg>/i, (_, inner) =>
      inner.trim(),
    );
  } catch (e) {
    console.error("Failed to parse SVG from data URL:", e);
    return dataUrl;
  }
}

const splash = getInnerSVG(SplashDataURL);

type Provider = Ref<string>;

const registry = shallowReactive(new Set<Provider>());

export function register(provider: Provider) {
  registry.add(provider);
  return () => registry.delete(provider);
}

const injectedStyle = `
<style>
  text {
    fill: white;
    dominant-baseline: middle;
    text-anchor: middle;
  }
</style>
`;

// Exported (module-scope, shared across every importer) so `<script setup>`
// below can reference it directly — Vue merges a plain `<script>` and
// `<script setup>` in the same SFC into one module scope, no import needed.
export const content = computed(() => {
  if (registry.size === 0) return splash;
  return (
    injectedStyle +
    Array.from(registry)
      .map(({ value }) => value)
      .join("\n")
  );
});
</script>

<script setup lang="ts">
// `appConfig`/`server` live here, not the plain block above: nothing outside
// this component needs them (unlike `register`/`content`), and `<script
// setup>`'s top-level await is safely transformed by Vue's compiler
// (`withAsyncContext`) instead of becoming a genuine ES-module top-level
// await — which is what made this file the one remaining `vite build`
// failure (esbuild's target environment doesn't support real top-level
// await; every other module's `await useAppConfig()` already lives in a
// `<script setup>` block for the same reason).
import { watch } from "vue";
import { useAppConfig } from "@lib/config";

const appConfig = await useAppConfig();
const server = computed({
  get() {
    return appConfig.tele_canvas_url ?? "";
  },
  set(v: string) {
    appConfig.tele_canvas_url = v;
  },
});

watch(
  () => ({
    url_string: server.value,
    content: content.value,
  }),
  async ({ url_string, content }) => {
    try {
      const url = new URL(url_string);
      const res = await fetch(url.href, {
        method: "PUT",
        body: content,
      });
      if (!res.ok) {
        console.warn("Failed to fetch from RemoteCanvas server:", res.status);
      }
    } catch (e) {
      console.warn("Invalid RemoteCanvas server URL:", e);
    }
  },
  {
    immediate: true,
  },
);
</script>

<template>
  <div class="container">
    <svg viewBox="-240 -135 480 270" v-html="content"></svg>
    <input type="text" v-model="server" placeholder="RemoteCanvas Server URL" />
  </div>
</template>

<style lang="scss" scoped>
.container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1em;
  background-color: #0008;
  backdrop-filter: blur(4px);
  --size: calc(0.8 * max(100vh, 100vw));
}
svg {
  background-color: black;
  width: var(--size);
  height: calc(var(--size) * 9 / 16);
  border: 2px solid #aaa;
  &:hover {
    border-color: #08c;
  }
}
input {
  width: var(--size);
  padding: 0.5em;
  font-size: 1em;
  color: white;
  background-color: #0008;
  border: none;
  border-bottom: 2px solid #555;
  outline: none;
  &:hover {
    border-bottom-color: #aaa;
  }
  &:focus {
    border-bottom-color: #08c;
  }
}
</style>
