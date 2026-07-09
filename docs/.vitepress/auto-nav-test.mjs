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
  assert.equal(titleCase('applications'), 'Applications');
  assert.equal(titleCase('stage-f'), 'Stage F');
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
  w('applications/README.md', '# Application docs\n');
  w('applications/manage-cameras.md', '# Manage cameras\n');
  w('applications/single-capture.md', '# Single capture\n');
  w('history/refactor/README.md', '# Refactor archive\n');
  w('history/refactor/planner.md', '# The planner\n');
  w('history/refactor/proposals/A.md', '# Proposal A\n');
  w('dev/gates.md', '# The gate suite\n'); // no README in this section
  w('dev/typescript.md', '# TypeScript\n');
  // code-only dir: must be excluded from nav/sidebar
  fs.mkdirSync(path.join(root, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(root, 'schema', 'pixel-formats.ts'), 'export const x = 1;');

  const { nav, sidebar, sections } = buildAutoNav(root);

  // NAV: one per top-level dir that has markdown; schema excluded; title-cased.
  const navTexts = nav.map((n) => n.text);
  assert.deepEqual(navTexts, ['Applications', 'Dev', 'History'], 'nav order + titles');
  assert.ok(!navTexts.includes('Schema'), 'code-only schema/ excluded from nav');

  // NAV links: README-backed section -> "/section/", README-less -> first page.
  const byText = Object.fromEntries(nav.map((n) => [n.text, n.link]));
  assert.equal(byText.Applications, '/applications/', 'README section links to dir');
  assert.equal(byText.Dev, '/dev/gates', 'README-less section links to first page');
  assert.equal(byText.History, '/history/refactor/', 'nests to first README deep');

  // SIDEBAR applications: README/index first, then alphabetical, H1 as text.
  const apps = sidebar['/applications/'];
  assert.deepEqual(
    apps.map((i) => i.text),
    ['Application docs', 'Manage cameras', 'Single capture'],
    'applications sidebar order + H1 text',
  );
  assert.equal(apps[0].link, '/applications/', 'README item links to dir');
  assert.equal(apps[1].link, '/applications/manage-cameras');

  // SIDEBAR history: nested proposals/ becomes a collapsible group.
  const hist = sidebar['/history/'];
  const refactorGroup = hist.find((i) => i.text === 'Refactor');
  assert.ok(refactorGroup && Array.isArray(refactorGroup.items), 'refactor is a group');
  assert.equal(refactorGroup.collapsed, false, 'groups are collapsible (expanded)');
  assert.equal(refactorGroup.link, '/history/refactor/', 'group header links to its README');
  const proposalsGroup = refactorGroup.items.find((i) => i.text === 'Proposals');
  assert.ok(proposalsGroup && proposalsGroup.items.length === 1, 'nested proposals group');

  assert.equal(sections.length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── 3. firstHeading fallback + real docs sanity ────────────────────────────────
test('firstHeading returns null when no H1', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonav-h-'));
  const p = path.join(root, 'x.md');
  fs.writeFileSync(p, '(from user)\n\nsome prose\n');
  assert.equal(firstHeading(p), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scans the REAL docs tree without throwing', () => {
  const realDocs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { nav, sidebar } = buildAutoNav(realDocs);
  assert.ok(nav.length >= 5, 'expected >=5 real sections, got ' + nav.length);
  assert.ok(sidebar['/applications/'], 'applications sidebar present');
  // README-less section must fall back to first page, not a dangling "/section/".
  const dev = nav.find((n) => n.text === 'Dev');
  assert.ok(dev && dev.link !== '/dev/', 'dev has no README -> deep link, got ' + (dev && dev.link));
});

console.log(`\n${passed} test group(s) passed.`);
if (process.exitCode) console.error('SOME TESTS FAILED');
