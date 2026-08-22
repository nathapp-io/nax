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