#!/usr/bin/env bun
/**
 * One-shot S2-6 codemod over a package's src/ (nax-agent). Retired after S2-6.
 *
 *   bun scripts/s2-6-ts-extensions.ts ../nax-agent --dry-run   # count only
 *   bun scripts/s2-6-ts-extensions.ts ../nax-agent             # rewrite in place
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { rewriteTsExtensions } from "./lib/ts-extensions";

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

const [target, flag] = process.argv.slice(2);
if (!target) throw new Error("usage: s2-6-ts-extensions.ts <packageDir> [--dry-run]");
const pkg = resolve(target);
let specifiers = 0;
let files = 0;
for (const file of tsFiles(join(pkg, "src"))) {
  const before = readFileSync(file, "utf8");
  const { source, rewritten } = rewriteTsExtensions(before, file, isFile);
  if (rewritten === 0) continue;
  specifiers += rewritten;
  files += 1;
  if (flag !== "--dry-run") writeFileSync(file, source);
  process.stdout.write(`${relative(pkg, file)}: ${rewritten}\n`);
}
process.stdout.write(
  `${flag === "--dry-run" ? "would rewrite" : "rewrote"} ${specifiers} specifiers in ${files} files\n`,
);
