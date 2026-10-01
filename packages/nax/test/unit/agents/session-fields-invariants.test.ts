// test/unit/agents/session-fields-invariants.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");

async function grepSrc(pattern: RegExp): Promise<string[]> {
  const hits: string[] = [];
  const srcDir = join(ROOT, "src");
  const glob = new Bun.Glob("**/*.ts");
  for await (const rel of glob.scan({ cwd: srcDir, absolute: false })) {
    if (rel.endsWith(".test.ts")) continue;
    const src = await Bun.file(join(srcDir, rel)).text();
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (pattern.test(line) && !/^\s*(\/\/|\/?\*)/.test(line)) {
        hits.push(`src/${rel}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return hits;
}

describe("Legacy session field cleanup (#529 invariants)", () => {
  test("buildSessionName is not used in src/ (non-comment)", async () => {
    const hits = await grepSrc(/buildSessionName/);
    expect(hits).toEqual([]);
  });

  test("acpSessionName is not used in src/ (non-comment)", async () => {
    const hits = await grepSrc(/acpSessionName/);
    expect(hits).toEqual([]);
  });

  test("keepSessionOpen is not used in src/ (non-comment)", async () => {
    const hits = await grepSrc(/keepSessionOpen/);
    expect(hits).toEqual([]);
  });
});
