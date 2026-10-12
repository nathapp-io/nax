import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type NaxConfig } from "@/config";
import { _clearRootConfigCache, loadConfigForWorkdir } from "@/config/loader";
import { applyWorkflowMode } from "@/config/workflow-mode";

type Mode = "pipeline" | "workflow";

function makeConfig(opts: { mode?: Mode; acceptance: boolean; advisor?: boolean }): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    execution: { ...DEFAULT_CONFIG.execution, mode: opts.mode ?? "pipeline" },
    acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: opts.acceptance },
    ...(opts.advisor === undefined ? {} : { advisor: { ...DEFAULT_CONFIG.advisor, enabled: opts.advisor } }),
  } as NaxConfig;
}

describe("applyWorkflowMode", () => {
  test("pipeline mode returns the same object untouched and never warns", () => {
    const cfg = makeConfig({ acceptance: true });
    const warnings: string[] = [];
    expect(applyWorkflowMode(cfg, (m) => warnings.push(m))).toBe(cfg);
    expect(warnings).toEqual([]);
  });

  test("workflow mode forces acceptance off and the advisor on, with ONE warning naming both", () => {
    const cfg = makeConfig({ mode: "workflow", acceptance: true, advisor: false });
    const warnings: string[] = [];
    const out = applyWorkflowMode(cfg, (m) => warnings.push(m));
    expect(out.acceptance.enabled).toBe(false);
    expect(out.advisor?.enabled).toBe(true);
    expect(cfg.acceptance.enabled).toBe(true); // input not mutated
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("acceptance.enabled");
    expect(warnings[0]).toContain("advisor.enabled");
  });

  test("workflow mode with keys already at their forced values does not warn", () => {
    const cfg = makeConfig({ mode: "workflow", acceptance: false, advisor: true });
    const warnings: string[] = [];
    applyWorkflowMode(cfg, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});

describe("applyWorkflowMode at the per-package loader exit", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
    _clearRootConfigCache();
  });

  test("a package override cannot re-enable acceptance in workflow mode", async () => {
    dir = mkdtempSync(join(tmpdir(), "nax-wf-"));
    mkdirSync(join(dir, ".nax", "mono", "apps", "api"), { recursive: true });
    writeFileSync(join(dir, ".nax", "config.json"), JSON.stringify({ execution: { mode: "workflow" } }));
    writeFileSync(
      join(dir, ".nax", "mono", "apps", "api", "config.json"),
      JSON.stringify({ acceptance: { enabled: true } }),
    );
    const cfg = await loadConfigForWorkdir(join(dir, ".nax", "config.json"), "apps/api");
    expect(cfg.acceptance.enabled).toBe(false);
  });

  test("a root config in workflow mode resolves with acceptance off and the advisor on", async () => {
    dir = mkdtempSync(join(tmpdir(), "nax-wf-"));
    mkdirSync(join(dir, ".nax"), { recursive: true });
    writeFileSync(
      join(dir, ".nax", "config.json"),
      JSON.stringify({ execution: { mode: "workflow" }, acceptance: { enabled: true } }),
    );
    const cfg = await loadConfigForWorkdir(join(dir, ".nax", "config.json"));
    expect(cfg.acceptance.enabled).toBe(false);
    expect(cfg.advisor?.enabled).toBe(true);
  });
});
