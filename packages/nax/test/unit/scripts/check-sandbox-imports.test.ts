/**
 * The sandbox-runtime isolation gate. srt is a "beta research preview" with an
 * explicitly unstable API; confining it to one file confines every future
 * bump to one file. Proven by violating it.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../scripts/check-sandbox-imports.ts");

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

describe("check-sandbox-imports", () => {
  test("passes when srt is imported only from src/sandbox/srt-backend.ts", () => {
    const root = tree({
      "src/sandbox/srt-backend.ts": 'const m = await import("@anthropic-ai/sandbox-runtime");\n',
      "src/tools/bash.ts": 'import type { CommandLauncher } from "../sandbox";\n',
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });

  test("fails on a static import outside the backend", () => {
    const root = tree({ "src/tools/bash.ts": 'import { SandboxManager } from "@anthropic-ai/sandbox-runtime";\n' });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("src/tools/bash.ts:1");
  });

  test("fails on a dynamic import elsewhere in src/sandbox", () => {
    const root = tree({ "src/sandbox/probe.ts": 'await import("@anthropic-ai/sandbox-runtime");\n' });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
  });

  test("fails when src/sandbox imports an orchestrator module", () => {
    const root = tree({ "src/sandbox/launcher.ts": 'import { x } from "../pipeline/stages";\n' });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("orchestrator");
  });

  test("fails when src/sandbox imports an orchestrator module through the @/ alias", () => {
    const root = tree({ "src/sandbox/launcher.ts": 'import { x } from "@/pipeline/stages";\n' });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
  });

  test("ignores the specifier inside comments", () => {
    const root = tree({
      "src/tools/bash.ts": "// see @anthropic-ai/sandbox-runtime\n * @anthropic-ai/sandbox-runtime\n",
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });
});
