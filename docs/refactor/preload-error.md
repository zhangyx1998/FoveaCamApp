(From user)

I verified that the preload addresses passed from main.ts are:

```js
{
  renderer: '/Users/yuxuan/Lab/FoveaCamApp/app/.dist/electron/preload-renderer.cjs',
  profiler: '/Users/yuxuan/Lab/FoveaCamApp/app/.dist/electron/preload-profiler.cjs'
}
```

However, the renderer errored out:

```
Unable to load preload script: /Users/yuxuan/Lab/FoveaCamApp/app/.dist/electron/preload-renderer.cjs
(anonymous) @ VM120 renderer_init:2
VM120 renderer_init:2 TypeError: The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received 'http://localhost:5173/preload-renderer.cjs'
    at Module.createRequire (VM63 loader:2031:13)
    at Object.<anonymous> (VM122 preload-renderer.cjs:24:31)
    at Object.<anonymous> (VM122 preload-renderer.cjs:101:3)
    at Module._compile (VM63 loader:1820:14)
    at Module._extensions..js (VM63 loader:1953:10)
    at Module.load (VM63 loader:1540:32)
    at Module._load (VM63 loader:1342:12)
    at c._load (VM77 node_init:2:18047)
    at s._load (VM120 renderer_init:2:36002)
    at VM120 renderer_init:2:38071
```

I did a global search and confirmed non of my code transformed the FS path into the HTTP url shown in the error message. Electron seems unhappy to use a vite-served script for preload code. I suspect this is translated by the vite-plugin-electron layer.

---

BTW, you should use bundler config to ensure different preload entry points are bundled and emitted as separate self-contained file. Hand-keeping same code in different source files is not acceptable.


---

**Resolution (planner, 2026-07-06).** The http URL was not produced by
main.ts, Electron, or vite-plugin-electron's path handling — the preload
file *was* loaded from the disk path you passed (see `Module._compile` in
the stack). The culprit was **vite's CJS shim for `import.meta.url`**
inside the bundle: `createRequire(import.meta.url)` compiles to a shim
that, when a `document` exists (preloads have one), resolves via
`document.baseURI` — the dev server origin — and `createRequire` rejects
non-file URLs. Fix: CJS preloads use the module wrapper's ambient
`require` (`declare const require: NodeRequire`) — no `createRequire`,
no `import.meta` anywhere in preload sources.

**Deduplication directive: implemented.** The shared bridge is back in
one source file (`electron/preload-bridge.ts`); each preload entry is
now built by its own vite-plugin-electron (low-level API) build pass
with explicit `lib: { formats: ["cjs"], fileName: () => "<name>.cjs" }`,
so shared modules are inlined per output — self-contained without
hand-synced copies. Two plugin quirks worth remembering: it derives
format from package `type` (module → ESM-in-.cjs) unless `build.lib`
pins it, and passing `entry` alongside `build.lib` double-builds every
output. Standing gates now check the built preloads mechanically
(CJS, no relative imports, no `baseURI`/`import_meta`/`createRequire`).
