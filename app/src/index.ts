import { createApp } from "vue";
import App from "./App.vue";
import "./index.css";

createApp(App).mount("#app");

// Prevent global zooming on macOS
function preventZoom(e: WheelEvent) {
    if (e.metaKey || e.ctrlKey) e.preventDefault();
}

document.addEventListener("wheel", preventZoom, { passive: false });

import controller from "@lib/serial";
(window as any).controller = controller; // for debug
