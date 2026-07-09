// nav-trigger.ts — the auto-nav watch "sentinel".
//
// WHY THIS FILE EXISTS
// --------------------
// config.ts statically imports NAV_TRIGGER_STAMP from here, so this file is part
// of the config's esbuild bundle graph and therefore lands in VitePress's
// `configDeps` (see resolveUserConfig -> loadConfigFromFile.dependencies).
//
// VitePress only regenerates the navbar/sidebar when it fully re-resolves the
// config (recreateServer). It does that when a *configDep* file changes
// (vitepress dev server: handleHotUpdate -> `configDeps.includes(file)` ->
// recreateServer). Adding/removing/renaming a .md does NOT touch a configDep, so
// the sidebar would otherwise go stale in dev.
//
// The auto-nav watch plugin (auto-nav.ts) therefore rewrites THIS file whenever
// the docs *tree* changes structurally. That write is a configDep change, which
// makes VitePress re-run config.ts -> buildAutoNav() -> fresh nav + sidebar, live,
// with no manual restart. The stamp value itself is irrelevant; only its mtime/
// content-change matters. It is referenced (passed to autoNavWatch) so esbuild
// never tree-shakes the import away.
export const NAV_TRIGGER_STAMP = 0;
