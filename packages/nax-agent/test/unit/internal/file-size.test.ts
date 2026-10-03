import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileSizeOrZero } from "#src/internal/file-size";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

let root: string;
beforeEach(() => {
  root = makeTempDir("file-size-");
});
afterEach(() => cleanupTempDir(root));
test("counts UTF-8 bytes rather than characters", () => {
  const p = join(root, "text");
  writeFileSync(p, "héllo");
  expect(fileSizeOrZero(p)).toBe(6);
});
test("only a missing path maps to zero", () => {
  expect(fileSizeOrZero(join(root, "missing"))).toBe(0);
});
test("non-directory errors propagate", () => {
  const p = join(root, "text");
  writeFileSync(p, "x");
  expect(() => fileSizeOrZero(join(p, "child"))).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
});
