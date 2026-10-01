#!/usr/bin/env bun

/**
 * Fails if @anthropic-ai/sandbox-runtime is imported anywhere but
 * src/sandbox/srt-backend.ts, or if src/sandbox/ imports an orchestrator
 * module (P4 spec 5.1 / master plan D8: src/sandbox/ is part of the would-be
 * nax-coding package and must stay extractable).
 *
 * Takes an optional root so the gate can be tested against a fixture tree.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const ROOT = process.argv[2] ?? process.cwd();
const SCAN = join(ROOT, "src");
const ALLOWED_FILE = join("src", "sandbox", "srt-backend.ts");
const SANDBOX_DIR = join("src", "sandbox") + sep;
const SRT = /@anthropic-ai\/sandbox-runtime/;
const ORCHESTRATOR = /from\s+["'](?:@\/|(?:\.\.\/)+)(pipeline|execution|operations|prd|runtime)(?:\/|["'])/;

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

const violations: { file: string; line: number; text: string; why: string }[] = [];

for await (const file of walk(SCAN)) {
  const rel = relative(ROOT, file);
  const source = await readFile(file, "utf8");
  source.split("\n").forEach((text, index) => {
    const stripped = text.trim();
    if (stripped.startsWith("*") || stripped.startsWith("//")) return;
    if (SRT.test(text) && rel !== ALLOWED_FILE) {
      violations.push({ file: rel, line: index + 1, text: stripped, why: "srt outside src/sandbox/srt-backend.ts" });
    }
    if (rel.startsWith(SANDBOX_DIR) && ORCHESTRATOR.test(text)) {
      violations.push({
        file: rel,
        line: index + 1,
        text: stripped,
        why: "src/sandbox imports an orchestrator module",
      });
    }
  });
}

if (violations.length > 0) {
  console.error("sandbox import boundary violated:");
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}  (${v.why})`);
  process.exit(1);
}

console.log("check-sandbox-imports: clean");
