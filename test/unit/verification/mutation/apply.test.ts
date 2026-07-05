/**
 * Mutation apply/revert tests.
 *
 * Covers applyMutant and revertMutant — file-editing helpers used by the
 * mutation spot-check pipeline to inject a mutant and then restore the
 * original file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMutant, revertMutant } from "../../../../src/verification/mutation/apply";
import type { Mutant } from "../../../../src/verification/mutation/types";

describe("applyMutant", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-apply-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("AC1: writing a mutant writes m.after at line m.line", async () => {
    const filePath = join(tempDir, "apply.ts");
    const before = "if (a > b) {\n  return false;\n}\n";
    await Bun.write(filePath, before);

    const mutant: Mutant = {
      file: filePath,
      line: 1,
      before: "if (a > b) {",
      after: "if (a < b) {",
      operatorId: "ts:cmp-flip",
    };

    await applyMutant(mutant);

    const content = await Bun.file(filePath).text();
    const lines = content.split("\n");
    expect(lines[mutant.line - 1]).toBe(mutant.after);
  });

  test("AC1: writing a mutant to line N replaces that single line", async () => {
    const filePath = join(tempDir, "multi.ts");
    const original = "line1\nline2\nline3\nline4\n";
    await Bun.write(filePath, original);

    const mutant: Mutant = {
      file: filePath,
      line: 3,
      before: "line3",
      after: "MUTATED_LINE",
      operatorId: "ts:noop",
    };

    await applyMutant(mutant);

    const content = await Bun.file(filePath).text();
    const lines = content.split("\n");
    expect(lines[0]).toBe("line1");
    expect(lines[1]).toBe("line2");
    expect(lines[2]).toBe("MUTATED_LINE");
    expect(lines[3]).toBe("line4");
  });
});

describe("revertMutant", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-revert-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("AC2: applyMutant followed by revertMutant restores the file byte-for-byte", async () => {
    const filePath = join(tempDir, "roundtrip.ts");
    const original = "if (a > b) {\n  return false;\n}\n";
    await Bun.write(filePath, original);

    const originalBuffer = await Bun.file(filePath).arrayBuffer();

    const mutant: Mutant = {
      file: filePath,
      line: 1,
      before: "if (a > b) {",
      after: "if (a < b) {",
      operatorId: "ts:cmp-flip",
    };

    await applyMutant(mutant);
    const afterApply = await Bun.file(filePath).text();
    expect(afterApply).not.toBe(original);

    await revertMutant(mutant);

    const restored = await Bun.file(filePath).arrayBuffer();
    expect(Buffer.from(originalBuffer).equals(Buffer.from(restored))).toBe(true);
  });

  test("AC2: revertMutant restores with nested directory present", async () => {
    mkdirSync(join(tempDir, "nested"));
    const filePath = join(tempDir, "nested", "deep.ts");
    const original = "const x = 1;\nconst y = 2;\n";
    await Bun.write(filePath, original);

    const originalBuffer = await Bun.file(filePath).arrayBuffer();

    const mutant: Mutant = {
      file: filePath,
      line: 2,
      before: "const y = 2;",
      after: "const y = 99;",
      operatorId: "ts:literal-flip",
    };

    await applyMutant(mutant);
    await revertMutant(mutant);

    const restored = await Bun.file(filePath).arrayBuffer();
    expect(Buffer.from(originalBuffer).equals(Buffer.from(restored))).toBe(true);
  });
});
