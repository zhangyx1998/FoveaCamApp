// nav-core.mjs — PURE tree-scan core for the auto-nav plugin.
//
// This module is deliberately plain ESM JavaScript (no TypeScript syntax) so it
// can be:
//   1. imported by the VitePress config (docs/.vitepress/config.ts), and
//   2. imported and unit-tested directly with `node docs/.vitepress/auto-nav.test.mjs`
//      — no TS loader, no vitest, no app-suite wiring.
//
// It performs a single synchronous scan of the docs tree and derives the
// VitePress navbar + sidebar. NO nav/sidebar structure is ever hand-maintained:
// adding / removing / renaming a markdown file changes the output automatically.
//
// Contract (all paths absolute):
//   buildAutoNav(srcDir)        -> { sections, nav, sidebar }
//   scanSectionItems(srcDir,d)  -> sidebar item array for one top-level section
//   firstHeading(absFile)       -> first `# heading` text, or null
//   titleCase(name)             -> "stage-f" -> "Stage F"

import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set(['.vitepress', 'node_modules', '.git']);
const INDEX_BASENAMES = new Set(['readme', 'index']); // case-insensitive

/** Title-case a directory / file basename: "stage-f" -> "Stage F". */
export function titleCase(name) {
  return String(name)
    .replace(/[-_/]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Read a markdown file's first `# H1` heading text (null if none). */
export function firstHeading(absFile) {
  let text;
  try {
    text = fs.readFileSync(absFile, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) { if (line.trim() === '---') inFrontmatter = false; continue; }
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

function isIndexFile(basename) {
  return INDEX_BASENAMES.has(basename.replace(/\.md$/i, '').toLowerCase());
}

/** Clean VitePress link for a markdown file, relative to srcDir. */
function toLink(srcDir, absFile) {
  let rel = path.relative(srcDir, absFile).split(path.sep).join('/');
  rel = rel.replace(/\.md$/i, '');
  const base = rel.split('/').pop();
  if (isIndexFile(base + '.md')) {
    const dir = rel.slice(0, rel.length - base.length); // keeps trailing slash or ''
    return '/' + dir; // "/", "/applications/", "/history/refactor/"
  }
  return '/' + rel; // "/applications/manage-cameras"
}

/** Does a directory (recursively) contain at least one .md file? */
function hasMarkdown(absDir) {
  for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    if (e.isDirectory()) { if (hasMarkdown(path.join(absDir, e.name))) return true; }
    else if (e.name.toLowerCase().endsWith('.md')) return true;
  }
  return false;
}

/** Split a directory's children into sorted {files, dirs}. */
function readChildren(absDir) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const files = [];
  const dirs = [];
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      if (hasMarkdown(abs)) dirs.push({ name: e.name, abs });
    } else if (e.name.toLowerCase().endsWith('.md')) {
      files.push({ name: e.name, abs });
    }
  }
  // Files: README/index first, then alphabetical.
  files.sort((a, b) => {
    const ai = isIndexFile(a.name), bi = isIndexFile(b.name);
    if (ai !== bi) return ai ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  // Dirs: alphabetical.
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return { files, dirs };
}

/** Recursively build sidebar items for a directory. */
function buildDirItems(srcDir, absDir) {
  const { files, dirs } = readChildren(absDir);
  const items = [];
  // Pages first (README/index leads).
  for (const f of files) {
    items.push({
      text: firstHeading(f.abs) || titleCase(f.name.replace(/\.md$/i, '')),
      link: toLink(srcDir, f.abs),
    });
  }
  // Then nested directories as collapsible groups (mirrors the tree).
  for (const d of dirs) {
    const group = {
      text: titleCase(d.name),
      collapsed: false, // rendered as an expanded-but-collapsible group
      items: buildDirItems(srcDir, d.abs),
    };
    // If the subdir has its own README/index, link the group header to it.
    const idx = fs
      .readdirSync(d.abs)
      .find((n) => isIndexFile(n) && n.toLowerCase().endsWith('.md'));
    if (idx) group.link = toLink(srcDir, path.join(d.abs, idx));
    items.push(group);
  }
  return items;
}

/** Public: sidebar item array for one top-level section directory name. */
export function scanSectionItems(srcDir, sectionDirName) {
  return buildDirItems(srcDir, path.join(srcDir, sectionDirName));
}

/** Find the landing link for a section (its README/index, else first page). */
function sectionLandingLink(srcDir, absDir) {
  const idx = fs
    .readdirSync(absDir)
    .find((n) => isIndexFile(n) && n.toLowerCase().endsWith('.md'));
  if (idx) return toLink(srcDir, path.join(absDir, idx));
  // else: first .md in sorted tree order (depth-first, files before dirs).
  const { files, dirs } = readChildren(absDir);
  if (files.length) return toLink(srcDir, files[0].abs);
  for (const d of dirs) {
    const deep = sectionLandingLink(srcDir, d.abs);
    if (deep) return deep;
  }
  return null;
}

/**
 * Public: scan the whole docs tree and derive nav + sidebar.
 * @param {string} srcDir absolute path to the docs root
 * @returns {{ sections: {name:string,link:string}[], nav: any[], sidebar: Record<string, any[]> }}
 */
export function buildAutoNav(srcDir) {
  const top = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => hasMarkdown(path.join(srcDir, name))) // skip code-only dirs (e.g. schema/)
    .sort((a, b) => a.localeCompare(b));

  const nav = [];
  const sidebar = {};
  const sections = [];

  for (const name of top) {
    const abs = path.join(srcDir, name);
    const link = sectionLandingLink(srcDir, abs);
    if (!link) continue;
    nav.push({ text: titleCase(name), link });
    sidebar['/' + name + '/'] = buildDirItems(srcDir, abs);
    sections.push({ name, link });
  }

  return { sections, nav, sidebar };
}
