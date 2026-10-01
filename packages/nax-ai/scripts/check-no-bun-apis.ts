/**
 * Gate: no Bun-specific APIs in shipped source.
 *
 * This package declares `engines.node >= 22.19` and is consumed from npm by
 * projects that may run on Node, Bun or Deno. A single `Bun.file` or
 * `Bun.spawn` reaching `src/` makes it Bun-only, and — because the primary
 * consumer runs on Bun — nothing would fail until someone else installed it.
 *
 * That asymmetry is the whole reason this is a build gate rather than a code
 * review note: the environment that would catch the mistake is the one least
 * likely to be running.
 *
 * Use `node:` builtins and web globals (`fetch`, `AbortSignal`) instead.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIR = join(ROOT, "src");

/**
 * Matches `Bun.` as a member access on the global, and the `bun:` module
 * protocol. Word-boundary-prefixed so identifiers that merely end in "Bun"
 * do not trip it.
 */
const BUN_GLOBAL = /(?<![\w$.])Bun\s*\./;
const BUN_MODULE = /from\s+["']bun:[\w-]+["']|import\s*\(\s*["']bun:[\w-]+["']/;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

async function main(): Promise<void> {
  const violations: Violation[] = [];

  for await (const file of walk(SCAN_DIR)) {
    const source = await readFile(file, "utf8");
    source.split("\n").forEach((text, index) => {
      // Comments legitimately discuss Bun (this gate's own rationale does),
      // so only flag lines that are not purely commentary.
      const stripped = text.trim();
      if (stripped.startsWith("*") || stripped.startsWith("//")) return;
      if (BUN_GLOBAL.test(text) || BUN_MODULE.test(text)) {
        violations.push({ file: relative(ROOT, file), line: index + 1, text: stripped });
      }
    });
  }

  if (violations.length > 0) {
    console.error(`Bun-specific APIs found in src/ (${violations.length}):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
    }
    console.error("\nThis package must run on Node. Use node: builtins or web globals instead.");
    process.exit(1);
  }

  console.log("check-no-bun-apis: clean");
}

await main();
