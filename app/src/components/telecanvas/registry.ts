// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// TeleCanvas PROVIDER registry (renderer, per-window module scope). App modules
// contribute SVG through `RemoteCanvasTeleport.vue` (hidden <svg> +
// MutationObserver → a registered provider ref); `content` merges every
// registered provider into one SVG string. The registry + merge is shared so
// the push (Pusher.vue, mounted per app window) and the TeleCanvas window's
// client-mode preview use one module scope.
//
// IMPORTANT — the registry is PER RENDERER: each window (app window, TeleCanvas
// window) has its own `registry`/`content`. The TeleCanvas window therefore
// cannot see an app window's providers directly; in host mode it takes its
// preview from the server's own live WebSocket stream instead (`telecanvas/view`
// mountView — truthful: it renders what the rig display renders). No
// cross-window provider relay exists by design.

import { computed, shallowReactive, type Ref } from "vue";

// Explicit `?url` keeps Vite's default asset handling for this import (the
// svg-loader plugin would otherwise compile a bare `.svg` import into a Vue
// component); typed as string by @zhangyx1998/svg-loader/client.
import SplashDataURL from "../RemoteCanvasSplash.svg?url";

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

/** The splash (inner) SVG shown when no provider is registered. */
export const splash = getInnerSVG(SplashDataURL);

type Provider = Ref<string>;

const registry = shallowReactive(new Set<Provider>());

/** Register an SVG provider (a reactive inner-SVG string ref). Returns an
 *  unregister callback. Call sites (RemoteCanvasTeleport.vue) are unchanged. */
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

/** The merged projection SVG (inner markup) across every registered provider,
 *  or the splash when none is registered. Consumed by the per-window push
 *  (Pusher.vue) and the TeleCanvas window's client-mode preview. */
export const content = computed(() => {
  if (registry.size === 0) return splash;
  return (
    injectedStyle +
    Array.from(registry)
      .map(({ value }) => value)
      .join("\n")
  );
});

/** True while at least one local provider is registered in THIS renderer. */
export const hasProviders = computed(() => registry.size > 0);
