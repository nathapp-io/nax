/**
 * Mutation apply/revert tests.
 *
 * Covers applyMutant and revertMutant — file-editing helpers used by the
 * mutation spot-check pipeline to inject a mutant and then restore the
 * original file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Mutant, applyMutant, revertMutant } from "@/verification";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("applyMutant", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-apply-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
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

  test("throws NaxError when m.line is past end-of-file", async () => {
    const filePath = join(tempDir, "short.ts");
    await Bun.write(filePath, "only-one-line\n");

    const mutant: Mutant = {
      file: filePath,
      line: 99,
      before: "only-one-line",
      after: "mutated",
      operatorId: "ts:noop",
    };

    await expect(applyMutant(mutant)).rejects.toMatchObject({
      message: expect.stringContaining("[mutation-apply]"),
      code: "MUTATION_LINE_OUT_OF_RANGE",
    });
  });
});

describe("revertMutant", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-revert-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
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

describe("revertMutant — verified, never positional", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-revert-verified-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  const mutantAt = (filePath: string, line: number): Mutant => ({
    file: filePath,
    line,
    before: "const y = 2;",
    after: "const y = 99;",
    operatorId: "ts:literal-flip",
  });

  test("reverting a line that holds the mutant reports success", async () => {
    const filePath = join(tempDir, "clean.ts");
    await Bun.write(filePath, "const x = 1;\nconst y = 2;\n");
    const mutant = mutantAt(filePath, 2);

    await applyMutant(mutant);

    expect(await revertMutant(mutant)).toEqual({ reverted: true });
  });

  test("a line rewritten since apply is reported, not overwritten", async () => {
    const filePath = join(tempDir, "shifted.ts");
    await Bun.write(filePath, "const x = 1;\nconst y = 2;\n");
    const mutant = mutantAt(filePath, 2);

    await applyMutant(mutant);
    // Something else — a formatter, codegen, the agent — rewrites the line.
    const rewritten = "const x = 1;\nconst y = someoneElsesEdit();\n";
    await Bun.write(filePath, rewritten);

    const result = await revertMutant(mutant);

    expect(result).toEqual({
      reverted: false,
      reason: "content-mismatch",
      actual: "const y = someoneElsesEdit();",
    });
    // The whole point: the foreign edit survives untouched.
    expect(await Bun.file(filePath).text()).toBe(rewritten);
  });

  test("a file that lost the line is reported, not extended", async () => {
    const filePath = join(tempDir, "truncated.ts");
    await Bun.write(filePath, "const x = 1;\nconst y = 2;\n");
    const mutant = mutantAt(filePath, 2);

    await applyMutant(mutant);
    const truncated = "const x = 1;";
    await Bun.write(filePath, truncated);

    const result = await revertMutant(mutant);

    expect(result).toEqual({ reverted: false, reason: "out-of-range", actual: null });
    expect(await Bun.file(filePath).text()).toBe(truncated);
  });

  test("reverting twice is not a second write — the line no longer holds the mutant", async () => {
    const filePath = join(tempDir, "double.ts");
    const original = "const x = 1;\nconst y = 2;\n";
    await Bun.write(filePath, original);
    const mutant = mutantAt(filePath, 2);

    await applyMutant(mutant);
    expect(await revertMutant(mutant)).toEqual({ reverted: true });

    const second = await revertMutant(mutant);

    expect(second.reverted).toBe(false);
    expect(await Bun.file(filePath).text()).toBe(original);
  });
});
