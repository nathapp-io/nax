// scripts/check-pi-ai-imports.ts
/**
 * Gate: pi-ai may only be imported where a backend adapts it.
 *
 * The package's value is that pi-ai can be replaced protocol by protocol. That
 * is only true while its types stay behind the adapter boundary — one import
 * in a shared module and the migration turns from a swap into a rewrite.
 *
 * Allowed: src/protocols/pi-client.ts, src/providers/pi-catalog.ts,
 * src/auth/pi-auth.ts.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIR = join(ROOT, "src");

// Covers named/type imports, dynamic imports, and side-effect-only static
// imports. The latter still couples a shared module to pi-ai and must remain
// outside the adapter boundary.
const PI_IMPORT = /(?:from\s+|import\s*(?:\(\s*)?)["']@earendil-works\/pi-ai/;
const ALLOWED = [/^src\/protocols\/pi-client\.ts$/, /^src\/providers\/pi-catalog\.ts$/, /^src\/auth\/pi-auth\.ts$/];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

const violations: { file: string; line: number; text: string }[] = [];

for await (const file of walk(SCAN_DIR)) {
  const rel = relative(ROOT, file);
  if (ALLOWED.some((pattern) => pattern.test(rel))) continue;

  const source = await readFile(file, "utf8");
  source.split("\n").forEach((text, index) => {
    const stripped = text.trim();
    if (stripped.startsWith("*") || stripped.startsWith("//")) return;
    if (PI_IMPORT.test(text)) violations.push({ file: rel, line: index + 1, text: stripped });
  });
}

if (violations.length > 0) {
  console.error(`pi-ai imported outside an adapter (${violations.length}):\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  console.error(
    "\npi-ai may only be imported in src/protocols/pi-client.ts, src/providers/pi-catalog.ts, or src/auth/pi-auth.ts.",
  );
  process.exit(1);
}

console.log("check-pi-ai-imports: clean");
