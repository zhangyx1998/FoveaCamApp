# TypeScript Notes

## Electron relative imports and NodeNext

Date: 2026-07-07

Symptom:

```text
Relative import paths need explicit file extensions in ECMAScript imports
when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean './bridge.js'?
```

This showed up in `app/electron/*.ts` for imports like:

```ts
import type { InvokeChannels } from "./bridge";
```

Runtime was fine because these Electron main/preload sources are not loaded by
raw Node ESM from the TypeScript source tree. They are bundled by Vite /
vite-plugin-electron first, and the bundle decides the final emitted module
shape. NodeNext's source-level "write `.js` in relative ESM imports" rule is
therefore the wrong checker model for these files.

Decision:

- Keep source imports extensionless in `app/electron/*.ts`.
- Type-check the Electron/Vite config program with
  `moduleResolution: "bundler"` instead of `NodeNext`.
- Mirror the same path aliases used by Vite so main/preload imports of shared
  `@lib/*` code resolve in the checker.
- Do not keep `app/tsconfig.node.json` as a referenced composite project from
  the renderer `app/tsconfig.json`: it overlaps shared `lib` files and makes
  `vue-tsc --noEmit` expect declaration outputs from the node project.

Related cleanup:

- `app/electron/electron-env.d.ts` now declares the local
  `VITE_DEV_SERVER_URL` env field directly instead of depending on
  `/// <reference types="vite-plugin-electron/electron-env" />`, whose package
  subpath did not resolve reliably from the app checker.

Separate issue, not fixed here:

- Directly checking `vite.config.ts` can still expose duplicate Vite type
  identity errors if the workspace has two physical Vite installs, for example
  root `node_modules/vite` and `app/node_modules/vite`. That is dependency
  layout/package-version hygiene, not the Electron relative-import issue.
