/** The root and ./internal entries never reach src/mcp/ or the MCP SDK (S5-5 spec §3.1). */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));
const IMPORT = /(?:import|export)[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveSpec(fromFile: string, spec: string): string | undefined {
  if (spec.startsWith("#src/")) return join(SRC, `${spec.slice(5)}.ts`);
  if (spec.startsWith(".")) {
    const base = resolve(dirname(fromFile), spec);
    return [base, `${base}.ts`, join(base, "index.ts")].find((p) => existsSync(p) && p.endsWith(".ts"));
  }
  return undefined;
}

function reach(entry: string): { readonly files: Set<string>; readonly packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file) || !existsSync(file)) continue;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? "";
      const local = resolveSpec(file, spec);
      if (local !== undefined) queue.push(local);
      else if (!spec.startsWith("node:")) packages.add(spec);
    }
  }
  return { files, packages };
}

describe("entry isolation", () => {
  for (const entry of ["index.ts", "internal.ts"]) {
    test(`${entry} never reaches src/mcp/ or @modelcontextprotocol/sdk`, () => {
      const { files, packages } = reach(join(SRC, entry));
      expect(files.size).toBeGreaterThan(10);
      expect([...files].filter((f) => f.includes(`${join(SRC, "mcp")}`))).toEqual([]);
      expect([...packages].filter((p) => p.startsWith("@modelcontextprotocol/"))).toEqual([]);
    });
  }

  test("the ./mcp entry does reach the SDK (the walker sees it)", () => {
    // Guards against a walker that silently resolves nothing: after Task 2 the
    // mcp entry imports connect.ts, which imports the SDK.
    const { files, packages } = reach(join(SRC, "mcp/index.ts"));
    expect(files.size).toBeGreaterThanOrEqual(4);
    expect([...packages]).toContain("@modelcontextprotocol/sdk/client/index.js");
  });
});
