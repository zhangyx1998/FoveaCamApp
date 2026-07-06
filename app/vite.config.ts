import { resolve } from "path";
import { fileURLToPath } from "url";
import fs from "node:fs";
import { defineConfig, Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import electron from "vite-plugin-electron/simple";
import root_package from "../package.json";
import workspace_package from "./package.json";

const external = Object.keys({
    ...(root_package.dependencies ?? {}),
    ...(workspace_package.dependencies ?? {}),
}) as string[];

// Externalize the native/runtime deps AND their subpaths (e.g. `core/Aravis`,
// `core/Vision`). Exact-string `external` misses subpaths, so the bundler would
// inline `core`'s loader — whose internal `require("./index.cjs")` then resolves
// against the bundle's directory (`.dist/electron`) instead of `core/dist`,
// crashing the orchestrator with MODULE_NOT_FOUND.
const isExternal = (id: string) =>
    external.some((e) => id === e || id.startsWith(`${e}/`));

const target = resolve(
    fileURLToPath(import.meta.url),
    "..",
    ".dist",
    "electron"
);

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
    fs.rmSync(target, { recursive: true, force: true });
    const isServe = command === "serve";
    const isBuild = command === "build";
    const sourcemap = isServe || !!process.env.VSCODE_DEBUG;
    const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "..");
    console.log("External Modules:", external);

    // Shared path aliases. Applied to both the renderer and the Node (main +
    // orchestrator) build so orchestrator code can reuse the pure-compute libs
    // under `@lib` (pid, stereo, geometry, vergence, ...) without relocating them.
    const alias = {
        "@": resolve(PROJECT_ROOT, "src"),
        "@lib": resolve(PROJECT_ROOT, "lib"),
        "@src": resolve(PROJECT_ROOT, "src"),
        "@modules": resolve(PROJECT_ROOT, "modules"),
        "@orchestrator": resolve(PROJECT_ROOT, "orchestrator"),
    };

    return {
        plugins: [
            vue(),
            electron({
                main: {
                    // Shortcut of `build.lib.entry`. The orchestrator is a
                    // second Node entry built alongside main; the main process
                    // forks it as a utilityProcess (.dist/electron/orchestrator.js).
                    entry: {
                        main: "electron/main.ts",
                        orchestrator: "orchestrator/index.ts",
                    },
                    vite: {
                        resolve: { alias },
                        build: {
                            sourcemap,
                            minify: isBuild,
                            outDir: target,
                            // Some third-party Node.js libraries may not be built correctly by Vite, especially `C/C++` addons,
                            // we can use `external` to exclude them to ensure they work correctly.
                            // Others need to put them in `dependencies` to ensure they are collected into `app.asar` after the app is built.
                            // Of course, this is not absolute, just this way is relatively simple. :)
                            rollupOptions: { external: isExternal },
                        },
                    },
                },
                preload: {
                    // Shortcut of `build.rollupOptions.input`.
                    // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
                    input: {
                        preload: "electron/preload.ts",
                        "preload-shm": "electron/preload-shm.ts",
                    },
                    vite: {
                        build: {
                            sourcemap: sourcemap ? "inline" : undefined, // #332
                            minify: isBuild,
                            outDir: target,
                            rollupOptions: {
                                external: isExternal,
                                // The plugin builds preloads as CJS but names
                                // them .mjs under `"type": "module"` — fine
                                // sandboxed (require is injected), fatal for
                                // the unsandboxed shm window where Electron
                                // loads .mjs as real ESM and bare `require`
                                // throws (V11b). Name them what they are.
                                output: {
                                    inlineDynamicImports: false,
                                    format: "cjs",
                                    entryFileNames: "[name].cjs",
                                },
                            },
                        },
                    },
                },
                // Ployfill the Electron and Node.js API for Renderer process.
                // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
                // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
                renderer: {
                    resolve: {
                        ...Object.fromEntries(
                            external.map((m) => [m, { type: "cjs" }])
                        ),
                    },
                },
            }),
        ],
        server:
            process.env.VSCODE_DEBUG &&
            (() => {
                const url = new URL(process.env.VITE_DEV_SERVER_URL);
                return {
                    host: url.hostname,
                    port: +url.port,
                };
            })(),
        clearScreen: false,
        optimizeDeps: {
            exclude: external,
        },
        resolve: { alias },
        build: {
            outDir: resolve(PROJECT_ROOT, ".dist", "renderer"),
        },
    };
});
