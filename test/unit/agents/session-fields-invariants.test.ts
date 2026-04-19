// test/unit/agents/session-fields-invariants.test.ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");

function grepSrc(pattern: RegExp): string[] {
  const hits: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const src = readFileSync(full, "utf-8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (pattern.test(line) && !/^\s*(\/\/|\/?\*)/.test(line)) {
          hits.push(`${full.replace(ROOT + "/", "")}:${i + 1}: ${line.trim()}`);
        }
      }
    }
  }
  walk(join(ROOT, "src"));
  return hits;
}

describe("Legacy session field cleanup (#529 invariants)", () => {
  test("buildSessionName is not used in src/ (non-comment)", () => {
    const hits = grepSrc(/buildSessionName/);
    expect(hits).toEqual([]);
  });

  test("acpSessionName is not used in src/ (non-comment)", () => {
    const hits = grepSrc(/acpSessionName/);
    expect(hits).toEqual([]);
  });

  test("keepSessionOpen is not used in src/ (non-comment)", () => {
    const hits = grepSrc(/keepSessionOpen/);
    expect(hits).toEqual([]);
  });
});
