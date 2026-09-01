#!/usr/bin/env bun

/**
 * Fails if @nathapp/nax-ai is imported anywhere but src/agents/native/.
 *
 * The package is swappable only while its surface has one consumer. Mirrors
 * scripts/check-adapter-no-config-import.sh, and nax-ai's own
 * check-pi-ai-imports gate.
 *
 * Takes an optional root so the gate can be tested against a fixture tree.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const ROOT = process.argv[2] ?? process.cwd();
const SCAN = join(ROOT, "src");
const ALLOWED_PREFIX = join("src", "agents", "native") + sep;
const IMPORT = /@nathapp\/nax-ai/;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

const violations: { file: string; line: number; text: string }[] = [];

for await (const file of walk(SCAN)) {
  const rel = relative(ROOT, file);
  if (rel.startsWith(ALLOWED_PREFIX)) continue;

  const source = await readFile(file, "utf8");
  source.split("\n").forEach((text, index) => {
    const stripped = text.trim();
    if (stripped.startsWith("*") || stripped.startsWith("//")) return;
    if (IMPORT.test(text)) violations.push({ file: rel, line: index + 1, text: stripped });
  });
}

if (violations.length > 0) {
  console.error("@nathapp/nax-ai may only be imported from src/agents/native/:");
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  process.exit(1);
}

console.log("check-nax-ai-imports: clean");
