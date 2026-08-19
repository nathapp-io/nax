#!/usr/bin/env bun
/**
 * Drift check: regenerates `src/finish/review/prompts.gen.ts` in memory from
 * `src/finish/review/references/*.md` and compares it to the committed file.
 *
 * The `.md` files are the canonical, human-editable source of the reviewer
 * prose; `prompts.gen.ts` is a derived artifact committed for import
 * ergonomics. If someone edits one without regenerating the other, this
 * check fails the build — run `bun run gen:review-prompts` to fix.
 *
 * Usage:
 *   bun scripts/check-review-prompts-generated.ts
 *
 * Exit codes:
 *   0 — generated file matches the committed file
 *   1 — drift detected (first differing line is named)
 */
import { join } from "node:path";
import { generatePromptsFileContent } from "./generate-review-prompts";

const ROOT = join(import.meta.dir, "..");
const OUTPUT_FILE = join(ROOT, "src", "finish", "review", "prompts.gen.ts");

function firstDifferingLine(
  expected: string,
  actual: string,
): { line: number; expected: string; actual: string } | null {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const max = Math.max(expectedLines.length, actualLines.length);
  for (let i = 0; i < max; i++) {
    if (expectedLines[i] !== actualLines[i]) {
      return { line: i + 1, expected: expectedLines[i] ?? "<EOF>", actual: actualLines[i] ?? "<EOF>" };
    }
  }
  return null;
}

async function main() {
  const expected = await generatePromptsFileContent();

  let actual: string;
  try {
    actual = await Bun.file(OUTPUT_FILE).text();
  } catch {
    console.error(`ERROR: ${OUTPUT_FILE} does not exist.`);
    console.error("Run 'bun run gen:review-prompts' to generate it.");
    process.exit(1);
    return;
  }

  if (actual === expected) {
    console.log("OK: prompts.gen.ts matches src/finish/review/references/*.md.");
    return;
  }

  const diff = firstDifferingLine(expected, actual);
  console.error("ERROR: src/finish/review/prompts.gen.ts is out of date with src/finish/review/references/*.md.");
  if (diff) {
    console.error(`\nFirst differing line: ${diff.line}`);
    console.error(`  expected: ${diff.expected}`);
    console.error(`  actual:   ${diff.actual}`);
  }
  console.error("\nRun 'bun run gen:review-prompts' to regenerate, then commit the result.");
  process.exit(1);
}

await main();
