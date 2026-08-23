import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReport, scanEscapeHatches } from "@scripts/check-test-escape-hatches";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

function write(root: string, rel: string, content: string) {
  mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(root, rel), content);
}

const BASE = { asAny: 0, tsSuppress: 0, ratchetAllow: 0, absentValue: 0 };

describe("scanEscapeHatches", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("nax-hatches-");
  });
  afterEach(() => cleanupTempDir(root));

  test("counts each hatch kind separately", async () => {
    write(
      root,
      "test/unit/a.test.ts",
      [
        "const x = foo as any;",
        "// @ts-expect-error deliberate",
        "const y = bar as unknown as Baz; // test-ratchet-allow: as-unknown-as",
      ].join("\n"),
    );
    const { counts } = await scanEscapeHatches(root);
    expect(counts).toEqual({ asAny: 1, tsSuppress: 1, ratchetAllow: 1, absentValue: 0 });
  });

  test("counts every hatch on a line, not the line once", async () => {
    write(root, "test/unit/a.test.ts", "call(x as any, y as any);\n");
    expect((await scanEscapeHatches(root)).counts.asAny).toBe(2);
  });

  test("does not match `as anything` or `anyway`", async () => {
    write(root, "test/unit/a.test.ts", "const x = foo as anything;\nconst anyway = 1;\n");
    expect((await scanEscapeHatches(root)).counts.asAny).toBe(0);
  });

  test("counts @ts-ignore and @ts-nocheck alongside @ts-expect-error", async () => {
    write(root, "test/unit/a.test.ts", "// @ts-ignore\n// @ts-nocheck\n// @ts-expect-error\n");
    expect((await scanEscapeHatches(root)).counts.tsSuppress).toBe(3);
  });

  test("counts absentValue and nullValue call sites", async () => {
    write(
      root,
      "test/unit/a.test.ts",
      [
        "const a = absentValue<IAgentManager>();",
        "const b = nullValue<string>();",
        "const c = absentValue<Logger>();",
      ].join("\n"),
    );
    const { counts } = await scanEscapeHatches(root);
    expect(counts.absentValue).toBe(3);
  });

  test("does not match absentValue or nullValue without a type argument", async () => {
    write(root, "test/unit/a.test.ts", "const x = absentValue;\nconst y = nullValue;\n");
    expect((await scanEscapeHatches(root)).counts.absentValue).toBe(0);
  });

  test("does not scan src/, scripts/ or bin/", async () => {
    mkdirSync(join(root, "test"), { recursive: true });
    write(root, "src/foo.ts", "const x = a as any;\n");
    write(root, "scripts/foo.ts", "const x = a as any;\n");
    write(root, "bin/foo.ts", "const x = a as any;\n");
    expect((await scanEscapeHatches(root)).counts.asAny).toBe(0);
  });

  test("records per-file counts", async () => {
    write(root, "test/unit/a.test.ts", "const x = a as any;\nconst y = b as any;\n");
    write(root, "test/unit/b.test.ts", "// @ts-ignore\n");
    const { byFile } = await scanEscapeHatches(root);
    expect(byFile["test/unit/a.test.ts"]?.asAny).toBe(2);
    expect(byFile["test/unit/b.test.ts"]?.tsSuppress).toBe(1);
  });
});

describe("formatReport", () => {
  const scan = (counts: Partial<typeof BASE>, byFile = {}) => ({ counts: { ...BASE, ...counts }, byFile });

  test("passes when every counter is at or below baseline", () => {
    const { ok, message } = formatReport(scan({ asAny: 5 }), {
      counts: { ...BASE, asAny: 5 },
      updatedAt: "",
    });
    expect(ok).toBe(true);
    expect(message).toContain("[OK]");
    expect(message).toContain("asAny=5");
  });

  test("notes each counter that shrank", () => {
    const { ok, message } = formatReport(scan({ asAny: 2, tsSuppress: 1 }), {
      counts: { ...BASE, asAny: 5, tsSuppress: 3 },
      updatedAt: "",
    });
    expect(ok).toBe(true);
    expect(message).toContain("asAny ↓ 3");
    expect(message).toContain("tsSuppress ↓ 2");
  });

  test("fails when any single counter grows, naming the offending file", () => {
    const { ok, message, grown } = formatReport(
      scan({ asAny: 5, ratchetAllow: 4 }, { "test/a.test.ts": { ratchetAllow: 4 } }),
      {
        counts: { ...BASE, asAny: 5, ratchetAllow: 1 },
        updatedAt: "",
        byFile: { "test/a.test.ts": { ratchetAllow: 1 } },
      },
    );
    expect(ok).toBe(false);
    expect(grown).toEqual(["ratchetAllow"]);
    expect(message).toContain("ratchetAllow: 1 → 4");
    expect(message).toContain("test/a.test.ts");
  });

  test("reports every grown counter, not just the first", () => {
    const { grown } = formatReport(scan({ asAny: 9, tsSuppress: 9 }), { counts: BASE, updatedAt: "" });
    expect(grown).toEqual(["asAny", "tsSuppress"]);
  });

  test("fails when no baseline exists", () => {
    const { ok, message } = formatReport(scan({ asAny: 1 }), null);
    expect(ok).toBe(false);
    expect(message).toContain("--update-baseline");
  });
});
