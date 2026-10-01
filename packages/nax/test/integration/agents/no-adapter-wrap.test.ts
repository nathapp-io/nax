/**
 * Integration test: wrapAdapterAsManager must not be publicly exported,
 * and must not be reintroduced anywhere in src/ at all — exported or not.
 *
 * ADR-020 Wave 2 privatized wrapAdapterAsManager, then deleted it entirely.
 * Production code and tests must use createRuntime(...).agentManager or the
 * test-only fakeAgentManager.
 *
 * The second describe block below subsumes the former shell gate
 * (scripts/check-no-adapter-wrap.sh, removed): it scans every file in src/
 * for a bare, non-comment occurrence of the symbol, which also catches a
 * local, unexported reintroduction that the barrel-export check above
 * cannot see.
 */

import { describe, expect, test } from "bun:test";

describe("ADR-020: wrapAdapterAsManager is forbidden", () => {
  test("is not exported from src/agents/utils", async () => {
    const mod = await import("@/agents/utils");
    expect("wrapAdapterAsManager" in mod).toBe(false);
  });

  test("fakeAgentManager is available from test helpers", async () => {
    const { fakeAgentManager } = await import("@test/helpers");
    expect(typeof fakeAgentManager).toBe("function");
  });
});

describe("ADR-020: wrapAdapterAsManager must not exist anywhere in src/", () => {
  interface Violation {
    file: string;
    line: number;
    code: string;
  }

  test("no non-comment occurrence of wrapAdapterAsManager in src/", async () => {
    const SRC_DIR = `${process.cwd()}/src`;
    const glob = new Bun.Glob("**/*.ts");
    const violations: Violation[] = [];

    for await (const file of glob.scan({ cwd: SRC_DIR, absolute: true })) {
      if (file.endsWith(".d.ts")) continue;

      const content = await Bun.file(file).text();
      const lines = content.split("\n");
      const relativePath = file.replace(`${SRC_DIR}/`, "");

      lines.forEach((line, i) => {
        if (!line.includes("wrapAdapterAsManager")) return;
        const trimmed = line.trim();
        // Skip comment-only lines — the ADR-020 history notes in
        // dispatch-context.ts are expected and stay in place.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        violations.push({ file: relativePath, line: i + 1, code: trimmed });
      });
    }

    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line}: ${v.code}`).join("\n");
      throw new Error(
        `Found ${violations.length} wrapAdapterAsManager occurrence(s) in src/:\n${msg}\n\nUse createRuntime(...).agentManager or fakeAgentManager() instead.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
