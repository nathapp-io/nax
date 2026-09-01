/**
 * The wire-isolation gate.
 *
 * nax-ai is replaceable only while every import of it sits behind one
 * directory. This mirrors check-adapter-no-config-import.sh, and nax-ai's own
 * check-pi-ai-imports, for the same reason.
 *
 * The gate is proven by violating it: a gate never seen to fail is not a gate.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../scripts/check-nax-ai-imports.ts");

function runGate(root: string): { code: number; out: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT, root]);
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nax-gate-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return root;
}

describe("check-nax-ai-imports", () => {
  test("passes when nax-ai is imported only from src/agents/native", () => {
    const root = tree({
      "src/agents/native/client.ts": 'import { createClient } from "@nathapp/nax-ai";\n',
      "src/agents/registry.ts": 'import { NativeAgentAdapter } from "./native";\n',
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });

  test("fails when nax-ai is imported from outside that directory", () => {
    const root = tree({
      "src/agents/manager.ts": 'import { createClient } from "@nathapp/nax-ai";\n',
    });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("src/agents/manager.ts");
  });

  test("ignores the import name inside a comment", () => {
    const root = tree({
      "src/agents/manager.ts": "// see @nathapp/nax-ai for the client\nexport const x = 1;\n",
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });
});
