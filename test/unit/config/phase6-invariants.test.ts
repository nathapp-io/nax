// test/unit/config/phase6-invariants.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

async function readSrc(relPath: string): Promise<string> {
  return await Bun.file(join(REPO_ROOT, relPath)).text();
}

describe("Phase 6 invariants — migration shim removal", () => {
  test("agent-migration.ts file does not exist", () => {
    expect(existsSync(join(REPO_ROOT, "src/config/agent-migration.ts"))).toBe(false);
  });

  test("loader.ts does not import applyAgentConfigMigration", async () => {
    const code = await readSrc("src/config/loader.ts");
    expect(code).not.toContain("applyAgentConfigMigration");
    expect(code).not.toContain("agent-migration");
  });

  test("AutoModeConfigSchema does not declare defaultAgent field", async () => {
    const code = await readSrc("src/config/schemas.ts");
    // extract the AutoModeConfigSchema block
    const start = code.indexOf("const AutoModeConfigSchema");
    const end = code.indexOf("});", start);
    const block = code.slice(start, end);
    expect(block).not.toContain("defaultAgent:");
  });

  test("AutoModeConfigSchema does not declare fallbackOrder field", async () => {
    const code = await readSrc("src/config/schemas.ts");
    const start = code.indexOf("const AutoModeConfigSchema");
    const end = code.indexOf("});", start);
    const block = code.slice(start, end);
    expect(block).not.toContain("fallbackOrder:");
  });

  test("no src file outside src/config/ reads autoMode.defaultAgent", async () => {
    const proc = Bun.spawn(
      ["grep", "-rln", "autoMode\\.defaultAgent", "src/", "--include=*.ts"],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const offenders = out.trim().split("\n").filter((l) => l.length > 0 && !l.includes("src/config/"));
    expect(offenders).toEqual([]);
  });

  test("no src file reads autoMode.fallbackOrder", async () => {
    const proc = Bun.spawn(
      ["grep", "-rln", "autoMode\\.fallbackOrder", "src/", "--include=*.ts"],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const offenders = out.trim().split("\n").filter((l) => l.length > 0);
    expect(offenders).toEqual([]);
  });

  test("resolveDefaultAgent does not reference autoMode.defaultAgent", async () => {
    const code = await readSrc("src/agents/utils.ts");
    expect(code).not.toContain("autoMode.defaultAgent");
  });

  test("AgentManager.getDefault does not reference autoMode.defaultAgent", async () => {
    const code = await readSrc("src/agents/manager.ts");
    expect(code).not.toContain("autoMode.defaultAgent");
  });

  test("validate.ts reads agent.default not autoMode.defaultAgent", async () => {
    const code = await readSrc("src/config/validate.ts");
    expect(code).not.toContain("autoMode.defaultAgent");
    expect(code).not.toContain("autoMode.fallbackOrder");
  });
});
