import { createApp } from "vue";
import "./index.css";

// The profiler window (docs/refactor/orchestrator.md §7.1 S4) loads this same
// bundle/HTML with `?profiler=1` — mount its thin read-only shell instead of
// the main app. Dynamic imports so each window's mount path doesn't need the
// other's component tree evaluated first.
const isProfiler = new URLSearchParams(location.search).has("profiler");

if (isProfiler) {
    import("./profiler/ProfilerWindow.vue").then(({ default: ProfilerWindow }) => {
        createApp(ProfilerWindow).mount("#app");
    });
} else {
    import("./App.vue").then(({ default: App }) => {
        createApp(App).mount("#app");
    });
    import("core").then(({ cleanup }) => {
        window.addEventListener("beforeunload", cleanup);
    });
}

// Prevent global zooming on macOS
function preventZoom(e: WheelEvent) {
    if (e.metaKey || e.ctrlKey) e.preventDefault();
}

document.addEventListener("wheel", preventZoom, { passive: false });
