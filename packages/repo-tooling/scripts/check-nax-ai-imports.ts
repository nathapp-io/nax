#!/usr/bin/env bun

/**
 * Fails if @nathapp/nax-ai is imported outside the allow-listed sites of the
 * package being scanned (read from its package.json name):
 * - packages/nax: src/agents/catalog/ only. nax reaches the R3 usage and rate
 *   types through @nathapp/nax-agent's re-export (S1 spec section 7).
 * - packages/nax-agent: src/native/ and the R3 re-export src/cost/standard-types.ts.
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

interface AllowList {
  readonly prefixes: readonly string[];
  readonly files: readonly string[];
}

const NAX: AllowList = { prefixes: [join("src", "agents", "catalog") + sep], files: [] };
const NAX_AGENT: AllowList = {
  prefixes: [join("src", "native") + sep],
  files: [join("src", "cost", "standard-types.ts")],
};

async function allowListFor(root: string): Promise<AllowList> {
  const pkg = Bun.file(join(root, "package.json"));
  const name = (await pkg.exists()) ? ((await pkg.json()) as { name?: string }).name : undefined;
  return name === "@nathapp/nax-agent" ? NAX_AGENT : NAX;
}

const ALLOWED = await allowListFor(ROOT);
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
  if (ALLOWED.prefixes.some((prefix) => rel.startsWith(prefix)) || ALLOWED.files.includes(rel)) continue;

  const source = await readFile(file, "utf8");
  source.split("\n").forEach((text, index) => {
    const stripped = text.trim();
    if (stripped.startsWith("*") || stripped.startsWith("//")) return;
    if (IMPORT.test(text)) violations.push({ file: rel, line: index + 1, text: stripped });
  });
}

if (violations.length > 0) {
  console.error(`@nathapp/nax-ai may only be imported from ${[...ALLOWED.prefixes, ...ALLOWED.files].join(", ")}:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  process.exit(1);
}

console.log("check-nax-ai-imports: clean");
