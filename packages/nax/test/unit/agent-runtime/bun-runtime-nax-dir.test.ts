import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { bunAgentRuntime } from "@/agent-runtime/bun-runtime";

const REPORT = ".nax/features/f/workflow/r1/US-001/report.md";
let root: string;

beforeEach(() => {
  root = makeTempDir();
  for (const file of [REPORT, ".nax/.hidden/x.md", ".nax-wt/a.ts", ".git/HEAD", "src/a.ts"]) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "fixture");
  }
});

afterEach(() => cleanupTempDir(root));

async function glob(pattern: string, absolute = false): Promise<string[]> {
  const hits: string[] = [];
  for await (const hit of bunAgentRuntime.glob(pattern, { cwd: root, absolute })) hits.push(hit);
  return hits.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("Bun glob literal .nax prefix", () => {
  test("AC-1: async glob finds report under literal .nax", async () => {
    expect(await glob(".nax/features/**/report.md")).toEqual([REPORT]);
  });

  test("AC-2: sync glob finds report under literal .nax", () => {
    expect([...bunAgentRuntime.globSync(".nax/features/**/report.md", { cwd: root, absolute: false })]).toEqual([
      REPORT,
    ]);
  });

  test("AC-3: leading ./ is preserved", async () => {
    expect(await glob("./.nax/features/**/report.md")).toEqual([`./${REPORT}`]);
  });

  test("AC-4: deeper hidden segments remain hidden", async () => {
    expect(await glob(".nax/**/*")).toEqual([REPORT]);
  });

  test("AC-5: wildcard prefix does not expose hidden directories", async () => {
    expect(await glob("**/*")).toEqual(["src/a.ts"]);
  });

  test("AC-6: similarly named hidden directory stays hidden", async () => {
    expect(await glob(".nax-wt/**/*")).toEqual([]);
  });

  test("AC-7: brace prefix does not exempt .nax", async () => {
    expect(await glob("{.nax,src}/**/*")).toEqual(["src/a.ts"]);
  });

  test("AC-8: explicit .git stays hidden", async () => {
    expect(await glob(".git/*")).toEqual([]);
  });

  test("AC-9: absolute glob returns absolute report path", async () => {
    expect(await glob(".nax/features/**/report.md", true)).toEqual([join(root, REPORT)]);
  });
});
