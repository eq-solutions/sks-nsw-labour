#!/usr/bin/env node
/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/release.mjs — atomic version bumper
// ─────────────────────────────────────────────────────────────
//
// The SW cache key in sw.js MUST live as a literal string in that
// file so the browser detects the SW byte-change and triggers
// re-install. The sidebar version badge is now sourced from
// APP_VERSION in scripts/app-state.js (read at runtime).
//
// That leaves two refs to bump per release. This script bumps
// them together so we don't ship another v3.4.44-style "I missed
// half the version refs" follow-up.
//
// Usage:
//   node scripts/release.mjs 3.4.45
//
// Bumps:
//   1. const APP_VERSION = '3.4.X' in scripts/app-state.js
//   2. const CACHE = 'eq-field-v3.4.X' (and the // ... v3.4.X
//      comment) in sw.js
//
// Does NOT touch:
//   • The CHANGES IN v3.4.X comment block in index.html — that's
//     the changelog, you write it manually with what's in the
//     release.
//   • The visible sidebar badge — derives from APP_VERSION at
//     runtime now.
//
// After running this, edit the changelog block in index.html,
// stage everything, and commit.
// ─────────────────────────────────────────────────────────────

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const repoRoot   = resolve(__dirname, "..");

const target = process.argv[2];
if (!target || !/^\d+\.\d+\.\d+(\.\d+)?$/.test(target)) {
  console.error("Usage: node scripts/release.mjs <X.Y.Z[.W]>");
  console.error("Example: node scripts/release.mjs 3.4.45");
  process.exit(1);
}

async function bump(path, find, replace) {
  const full = resolve(repoRoot, path);
  const before = await readFile(full, "utf8");
  if (!find.test(before)) {
    console.error(`✗ ${path} — pattern not found: ${find}`);
    process.exit(2);
  }
  const after = before.replace(find, replace);
  if (after === before) {
    console.log(`= ${path} — already at ${target}`);
    return;
  }
  await writeFile(full, after, "utf8");
  console.log(`✓ ${path} — bumped to ${target}`);
}

await bump(
  "scripts/app-state.js",
  /const APP_VERSION = '\d+\.\d+\.\d+(\.\d+)?';/,
  `const APP_VERSION = '${target}';`,
);

// Two separate bumps — the SW comment and the CACHE const are on
// adjacent lines but a single multi-line regex was fragile to whitespace
// drift, so we patch each independently.
await bump(
  "sw.js",
  /Service Worker  v\d+\.\d+\.\d+(\.\d+)?/,
  `Service Worker  v${target}`,
);
await bump(
  "sw.js",
  /const CACHE = 'eq-field-v\d+\.\d+\.\d+(\.\d+)?';/,
  `const CACHE = 'eq-field-v${target}';`,
);

console.log("");
console.log(`Now write the CHANGES IN v${target} block in index.html, then:`);
console.log(`  git add scripts/app-state.js sw.js index.html`);
console.log(`  git commit -m "v${target} — <summary>"`);
