/**
 * BUG-15 — bin/nax.ts async action rejections were unhandled.
 *
 * `program.parse()` does not observe the promise returned by an async action
 * handler, so a rejection (invalid config, corrupt PRD) became an unhandled
 * rejection with a raw stack trace instead of the house-style red error every
 * other CLI path shows. The fix: `await program.parseAsync(...)` plus
 * try/catch wraps on the identified bare awaits in the run action and a
 * per-entry catch in `features list`.
 *
 * These are source-signature tests: importing bin/nax.ts would execute the
 * CLI (it ends with the parse call), so the file is read as text instead —
 * the same approach init.test.ts and plan-decompose-cli-wiring.test.ts use.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

async function readBinNaxSource(): Promise<string> {
  return await Bun.file(join(import.meta.dir, "../../../bin/nax.ts")).text();
}

function assertWrapped(src: string, needle: string, at: number): void {
  const tryIdx = src.lastIndexOf("try {", at);
  expect(tryIdx).toBeGreaterThan(0);
  expect(at - tryIdx).toBeLessThan(200);
  const catchIdx = src.indexOf("} catch", at);
  expect(catchIdx).toBeGreaterThan(0);
  expect(catchIdx - at).toBeLessThan(400);
}

describe("BUG-15 — bin/nax.ts observes async action promises", () => {
  test("uses await program.parseAsync instead of the unobserved program.parse()", async () => {
    const src = await readBinNaxSource();
    expect(src).toContain("await program.parseAsync");
    expect(src).not.toMatch(/program\.parse\(\)/);
  });

  test("wraps the run action's bare loadConfig await in try/catch", async () => {
    const src = await readBinNaxSource();
    const idx = src.indexOf("loadConfig(naxDir ?? undefined, cliOverrides)");
    expect(idx).toBeGreaterThan(0);
    assertWrapped(src, "loadConfig(naxDir ?? undefined, cliOverrides)", idx);
  });

  test("wraps every bare loadPRD(prdPath) await (TUI load + features list) in try/catch", async () => {
    const src = await readBinNaxSource();
    const occurrences = [...src.matchAll(/loadPRD\(prdPath\)/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    for (const m of occurrences) {
      assertWrapped(src, "loadPRD(prdPath)", m.index);
    }
  });
});

// ENH-47 (D-30): the latest.jsonl symlink used to be recreated via
// Bun.spawnSync(['rm', ...]) / Bun.spawnSync(['ln', '-s', ...]) with unchecked
// exit codes — a failed `ln -s` silently left a stale symlink (or, on a
// runner without GNU coreutils on PATH, never created one at all). Fixed to
// native fs.unlinkSync/fs.symlinkSync, which throw on failure instead of
// silently no-opping.
describe("ENH-47 — bin/nax.ts latest.jsonl symlink uses native fs calls", () => {
  test("imports symlinkSync/unlinkSync from node:fs, not spawning rm/ln", async () => {
    const src = await readBinNaxSource();
    expect(src).toMatch(/import\s*\{[^}]*\bsymlinkSync\b[^}]*\}\s*from\s*"node:fs"/);
    expect(src).toMatch(/import\s*\{[^}]*\bunlinkSync\b[^}]*\}\s*from\s*"node:fs"/);
  });

  test("recreates latest.jsonl via native unlinkSync + symlinkSync, not a shelled-out rm/ln", async () => {
    const src = await readBinNaxSource();
    const idx = src.indexOf('join(runsDir, "latest.jsonl")');
    expect(idx).toBeGreaterThan(0);

    const scope = src.slice(idx, idx + 600);
    expect(scope).toContain("unlinkSync(latestSymlink)");
    expect(scope).toContain("symlinkSync(");
    // Regression guard: no non-comment line may shell out to rm/ln again.
    const codeLines = scope
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("//") && !line.startsWith("*"));
    for (const line of codeLines) {
      expect(line).not.toMatch(/spawnSync\(\s*\[\s*["']rm["']/);
      expect(line).not.toMatch(/spawnSync\(\s*\[\s*["']ln["']/);
    }
  });
});
