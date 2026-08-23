import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReport, scanAsUnknownAs } from "@scripts/check-test-as-unknown-as";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

function write(root: string, rel: string, content: string) {
  mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(root, rel), content);
}

describe("scanAsUnknownAs", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("nax-as-unknown-");
  });
  afterEach(() => cleanupTempDir(root));

  test("counts `as unknown as` occurrences per file in test/", async () => {
    write(root, "test/unit/a.test.ts", "const x = foo as unknown as Bar;\nconst y = bar as unknown as Baz;\n");
    write(root, "test/unit/b.test.ts", "const z = baz as unknown as Qux;\n");
    const { count, byFile } = await scanAsUnknownAs(root);
    expect(count).toBe(3);
    expect(byFile["test/unit/a.test.ts"]).toBe(2);
    expect(byFile["test/unit/b.test.ts"]).toBe(1);
  });

  test("counts every cast on a line, not the line once", async () => {
    // A line-based count lets `a as unknown as B, c as unknown as D` read as one
    // cast, so joining two cast lines lowers the number without removing a cast.
    write(root, "test/unit/a.test.ts", "call(x as unknown as B, y as unknown as C);\n");
    const { count, byFile } = await scanAsUnknownAs(root);
    expect(count).toBe(2);
    expect(byFile["test/unit/a.test.ts"]).toBe(2);
  });

  test("a line's allow marker suppresses every cast on that line", async () => {
    write(
      root,
      "test/unit/a.test.ts",
      "call(x as unknown as B, y as unknown as C); // test-ratchet-allow: as-unknown-as\n",
    );
    expect((await scanAsUnknownAs(root)).count).toBe(0);
  });

  test("an allow marker on the preceding line suppresses the cast", async () => {
    write(root, "test/unit/a.test.ts", "// test-ratchet-allow: as-unknown-as\nconst x = foo as unknown as Bar;\n");
    expect((await scanAsUnknownAs(root)).count).toBe(0);
  });

  test("an allow marker on the following line suppresses the cast", async () => {
    // The formatter reflows long lines and can move a trailing comment onto its
    // own line, which silently un-suppresses a deliberately allowed cast.
    write(
      root,
      "test/unit/a.test.ts",
      "const x = foo as unknown as {\n  // test-ratchet-allow: as-unknown-as\n  a: string;\n};\n",
    );
    expect((await scanAsUnknownAs(root)).count).toBe(0);
  });

  test("matches across multiple files in nested dirs", async () => {
    write(root, "test/unit/sub/deep.test.ts", "const x = a as unknown as B;\n");
    write(root, "test/integration/nested/c.test.ts", "const y = c as unknown as D;\n");
    const { byFile } = await scanAsUnknownAs(root);
    expect(byFile["test/unit/sub/deep.test.ts"]).toBe(1);
    expect(byFile["test/integration/nested/c.test.ts"]).toBe(1);
  });

  test("does not match `as unknown` (no second `as`)", async () => {
    write(root, "test/unit/a.test.ts", "const x = foo as unknown;\n");
    expect((await scanAsUnknownAs(root)).count).toBe(0);
  });

  test("does not scan src/, scripts/, flows/, bin/", async () => {
    mkdirSync(join(root, "test"), { recursive: true });
    write(root, "src/foo.ts", "const x = a as unknown as B;\n");
    write(root, "scripts/foo.ts", "const x = a as unknown as B;\n");
    write(root, "flows/foo.ts", "const x = a as unknown as B;\n");
    write(root, "bin/foo.ts", "const x = a as unknown as B;\n");
    expect((await scanAsUnknownAs(root)).count).toBe(0);
  });
});

describe("formatReport", () => {
  test("returns OK when count equals baseline", () => {
    const { ok, message } = formatReport({ count: 1, byFile: { "test/a.test.ts": 1 } }, { count: 1, updatedAt: "" });
    expect(ok).toBe(true);
    expect(message).toContain("[OK]");
    expect(message).toContain("baseline: 1");
  });

  test("returns OK with shrunk note when count dropped", () => {
    const { ok, message } = formatReport({ count: 0, byFile: {} }, { count: 5, updatedAt: "" });
    expect(ok).toBe(true);
    expect(message).toContain("↓ 5 removed");
  });

  test("returns FAIL when count exceeds baseline", () => {
    const cur = { count: 3, byFile: { "test/a.test.ts": 3 } };
    const baseline = { count: 1, updatedAt: "", byFile: { "test/a.test.ts": 1 } };
    const { ok, message } = formatReport(cur, baseline);
    expect(ok).toBe(false);
    expect(message).toContain("[FAIL]");
    expect(message).toContain("2 new");
    expect(message).toContain("test/a.test.ts");
    expect(message).toContain("factory helpers");
  });

  test("returns FAIL when no baseline", () => {
    const { ok, message } = formatReport({ count: 1, byFile: {} }, null);
    expect(ok).toBe(false);
    expect(message).toContain("--update-baseline");
  });
});
