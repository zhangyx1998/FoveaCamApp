import { defineConfig } from 'vitepress';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildAutoNav, autoNavWatch } from './auto-nav';
import { NAV_TRIGGER_STAMP } from './nav-trigger';

// srcDir === docs root. VitePress resolves configPath as <root>/.vitepress/config.ts
// with root = the arg to `vitepress build docs`, so root IS docs and srcDir '.'
// already points at the docs tree. We compute the absolute path for the scanner.
const thisDir = path.dirname(fileURLToPath(import.meta.url)); // docs/.vitepress
const SRC_DIR = path.resolve(thisDir, '..'); // docs
const TRIGGER_FILE = path.resolve(thisDir, 'nav-trigger.ts');

// Auto-generated navbar + sidebar (never hand-maintained).
const { nav, sidebar } = buildAutoNav(SRC_DIR);

// ── ignoreDeadLinks: a targeted allowlist (function), NOT blanket `true`. ───────
// Links into SOURCE CODE (../app/…, ../core/…, schema/*.ts, any repo file path)
// must not fail the build — the docs intentionally point at code that lives
// outside the VitePress tree. But genuine broken INTRA-docs .md links must still
// surface. VitePress has no "warn" level for dead links (it either ignores or
// fails the build), so the strongest available surfacing is to let intra-docs
// breaks FAIL — i.e. we ignore ONLY out-of-docs/source targets and validate the
// rest normally.
const OUT_OF_DOCS = /(^|\/)(app|core|firmware|node_modules|schema)\//i;
const SOURCE_EXT =
  /\.(ts|tsx|js|cjs|mjs|mts|cts|cpp|cc|cxx|h|hpp|hxx|json|jsonc|vue|py|sh|bash|zsh|yml|yaml|toml|cmake|txt|log|cfg|ini|env)($|[#?])/i;

export default defineConfig({
  title: 'FoveaCam Duo',
  description:
    'Developer documentation for FoveaCam Duo — a stereo MEMS-foveated camera rig on Electron.',

  // Project Pages served under https://zhangyx1998.github.io/FoveaCamApp/ — the
  // base must match the repo name so assets/links resolve. Auto-nav emits
  // root-relative links (/manual/, …); VitePress rewrites them with this base.
  base: '/FoveaCamApp/',

  // root === docs; docs itself is the source tree.
  srcDir: '.',

  // VitePress does NOT treat README.md as a directory index on its own, so we
  // rewrite every README.md -> index.md. That makes /  serve docs/README.md and
  // /<section>/ serve <section>/README.md (the auto-nav links to these dir URLs).
  // Dead-link resolution is rewrite-aware (siteConfig.rewrites.inv), so authored
  // ./README.md links keep resolving.
  rewrites(id: string) {
    return id.replace(/(^|\/)README\.md$/, '$1index.md');
  },
  cleanUrls: false,
  lastUpdated: true,

  ignoreDeadLinks: [
    (url: string) => OUT_OF_DOCS.test(url) || SOURCE_EXT.test(url),
  ],

  // The docs are GitHub-flavored markdown full of bare identifiers in prose:
  // <serial>, <session>, Leaky<T>, AsyncIterable<Result>, and even "<script
  // setup>". With markdown html enabled these parse as (unclosed) Vue/HTML tags
  // and hard-fail the Vue SFC compile. Zero docs use intentional inline/block
  // HTML (verified by scan), so disabling raw-HTML passthrough escapes every bare
  // angle-bracket literally — exactly what the authors meant — with no doc edits.
  // VitePress features (containers, code groups, tables) emit HTML in the RENDERER
  // and are unaffected by this parse-time flag.
  markdown: {
    html: false,
  },

  themeConfig: {
    nav,
    sidebar,
    outline: { level: [2, 3], label: 'On this page' },
    docFooter: { prev: true, next: true },
    search: { provider: 'local' },
  },

  vite: {
    plugins: [
      autoNavWatch({ srcDir: SRC_DIR, triggerFile: TRIGGER_FILE, stamp: NAV_TRIGGER_STAMP }),
    ],
  },
});
