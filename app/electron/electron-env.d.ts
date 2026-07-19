// `Window.foveaBridge`'s ambient declaration lives in `../types.d.ts`
// instead of here: this file is only in tsconfig.node.json's program
// (main/preload), but `foveaBridge` is consumed by renderer code, which
// type-checks under the separate root tsconfig.json.

declare namespace NodeJS {
  interface ProcessEnv {
    VITE_DEV_SERVER_URL: string
    VSCODE_DEBUG?: 'true'
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬ dist-electron
     * │ ├─┬ main
     * │ │ └── index.js    > Electron-Main
     * │ └─┬ preload
     * │   └── index.mjs   > Preload-Scripts
     * ├─┬ dist
     * │ └── index.html    > Electron-Renderer
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}
