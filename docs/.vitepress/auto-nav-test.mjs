// auto-nav-test.mjs — headless unit test for the pure nav-core scan.
// Run: node docs/.vitepress/auto-nav-test.mjs
// (named *-test.mjs, not *.test.mjs, to stay outside the repo's *.test.[cm]js
//  gitignore rule so this deliverable is committable.)
// Uses only node:assert + node:test-free tiny harness (no vitest, no app suite).

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAutoNav, titleCase, firstHeading, scanSectionItems } from './nav-core.mjs';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('FAIL  ' + name + '\n      ' + (e && e.message));
    process.exitCode = 1;
  }
};

// ── 1. Pure helpers ────────────────────────────────────────────────────────────
test('titleCase splits on - and _', () => {
  assert.equal(titleCase('architecture'), 'Architecture');
  assert.equal(titleCase('serial-protocol'), 'Serial Protocol');
  assert.equal(titleCase('multi_window'), 'Multi Window');
});

// ── 2. Synthetic tree (hermetic) ───────────────────────────────────────────────
test('buildAutoNav on a synthetic tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonav-'));
  const w = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  w('README.md', '# Home\n');
  w('guide/README.md', '# Guide\n');
  w('guide/manage-cameras.md', '# Manage cameras\n');
  w('guide/single-capture.md', '# Single capture\n');
  w('reference/core/README.md', '# Core reference\n');
  w('reference/core/overview.md', '# Overview\n');
  w('reference/core/details/A.md', '# Detail A\n');
  w('notes/gates.md', '# The gate suite\n'); // no README in this section
  w('notes/typescript.md', '# TypeScript\n');
  // code-only dir: must be excluded from nav/sidebar
  fs.mkdirSync(path.join(root, 'codeonly'), { recursive: true });
  fs.writeFileSync(path.join(root, 'codeonly', 'pixel-formats.ts'), 'export const x = 1;');

  const { nav, sidebar, sections } = buildAutoNav(root);

  // NAV: one per top-level dir that has markdown; code-only excluded; title-cased.
  const navTexts = nav.map((n) => n.text);
  assert.deepEqual(navTexts, ['Guide', 'Notes', 'Reference'], 'nav order + titles');
  assert.ok(!navTexts.includes('Codeonly'), 'code-only dir excluded from nav');

  // NAV links: README-backed section -> "/section/", README-less -> first page.
  const byText = Object.fromEntries(nav.map((n) => [n.text, n.link]));
  assert.equal(byText.Guide, '/guide/', 'README section links to dir');
  assert.equal(byText.Notes, '/notes/gates', 'README-less section links to first page');
  assert.equal(byText.Reference, '/reference/core/', 'nests to first README deep');

  // SIDEBAR guide: README/index first, then alphabetical, H1 as text.
  const guide = sidebar['/guide/'];
  assert.deepEqual(
    guide.map((i) => i.text),
    ['Guide', 'Manage cameras', 'Single capture'],
    'guide sidebar order + H1 text',
  );
  assert.equal(guide[0].link, '/guide/', 'README item links to dir');
  assert.equal(guide[1].link, '/guide/manage-cameras');

  // SIDEBAR reference: nested details/ becomes a collapsible group.
  const ref = sidebar['/reference/'];
  const coreGroup = ref.find((i) => i.text === 'Core');
  assert.ok(coreGroup && Array.isArray(coreGroup.items), 'core is a group');
  assert.equal(coreGroup.collapsed, false, 'groups are collapsible (expanded)');
  assert.equal(coreGroup.link, '/reference/core/', 'group header links to its README');
  const detailsGroup = coreGroup.items.find((i) => i.text === 'Details');
  assert.ok(detailsGroup && detailsGroup.items.length === 1, 'nested details group');

  assert.equal(sections.length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── 3. firstHeading fallback + real docs sanity ────────────────────────────────
test('firstHeading returns null when no H1', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonav-h-'));
  const p = path.join(root, 'x.md');
  fs.writeFileSync(p, 'no heading here\n\nsome prose\n');
  assert.equal(firstHeading(p), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scans the REAL docs tree without throwing', () => {
  const realDocs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { nav, sidebar } = buildAutoNav(realDocs);
  assert.ok(nav.length >= 5, 'expected >=5 real sections, got ' + nav.length);
  assert.ok(sidebar['/manual/'], 'manual sidebar present');
  // README-less section must fall back to first page, not a dangling "/section/".
  const hw = nav.find((n) => n.text === 'Hardware');
  assert.ok(hw && hw.link !== '/hardware/', 'hardware has no README -> deep link, got ' + (hw && hw.link));
});

console.log(`\n${passed} test group(s) passed.`);
if (process.exitCode) console.error('SOME TESTS FAILED');
