import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { _clearRootConfigCache, loadConfigForWorkdir } from "@/config/loader";
import { applyWorkflowMode, warnDeprecatedPipelineMode } from "@/config/workflow-mode";

type Mode = "pipeline" | "workflow";

function configFor(opts: { mode?: Mode; acceptance: boolean; advisor?: boolean }): NaxConfig {
  return makeNaxConfig({
    execution: { mode: opts.mode ?? "pipeline" },
    acceptance: { enabled: opts.acceptance },
    ...(opts.advisor === undefined ? {} : { advisor: { enabled: opts.advisor } }),
  });
}

describe("applyWorkflowMode", () => {
  test("pipeline mode returns the same object untouched and never warns", () => {
    const cfg = configFor({ acceptance: true });
    const warnings: string[] = [];
    expect(applyWorkflowMode(cfg, (m) => warnings.push(m))).toBe(cfg);
    expect(warnings).toEqual([]);
  });

  test("workflow mode forces acceptance off and the advisor on, silently when they are the shipped defaults", () => {
    const cfg = configFor({ mode: "workflow", acceptance: true, advisor: false });
    const warnings: string[] = [];
    const out = applyWorkflowMode(cfg, (m) => warnings.push(m));
    expect(out.acceptance.enabled).toBe(false);
    expect(out.advisor?.enabled).toBe(true);
    expect(cfg.acceptance.enabled).toBe(true); // input not mutated
    // workflow is the default mode, so overriding untouched defaults is not news on every run
    expect(warnings).toEqual([]);
  });

  test("the shipped default config resolves in workflow mode without a warning", () => {
    const warnings: string[] = [];
    const out = applyWorkflowMode(DEFAULT_CONFIG, (m) => warnings.push(m));
    expect(out.acceptance.enabled).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("workflow mode forces shared story isolation: the workflow tree sits in the main checkout (nax#2479)", () => {
    const cfg = makeNaxConfig({
      execution: { mode: "workflow", storyIsolation: "worktree" },
      acceptance: { enabled: false },
      advisor: { enabled: true },
    });
    const warnings: string[] = [];
    const out = applyWorkflowMode(cfg, (m) => warnings.push(m));
    expect(out.execution.storyIsolation).toBe("shared");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("execution.storyIsolation=shared");
  });

  test("workflow mode with keys already at their forced values does not warn", () => {
    const cfg = configFor({ mode: "workflow", acceptance: false, advisor: true });
    const warnings: string[] = [];
    applyWorkflowMode(cfg, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});

describe("workflow is the default execution mode", () => {
  test("the shipped default config runs in workflow mode", () => {
    expect(DEFAULT_CONFIG.execution.mode).toBe("workflow");
  });
});

describe("warnDeprecatedPipelineMode", () => {
  test("pipeline mode warns once that it is deprecated and names workflow as the replacement", () => {
    const warnings: string[] = [];
    warnDeprecatedPipelineMode(configFor({ mode: "pipeline", acceptance: true }), (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('execution.mode "pipeline" is deprecated');
    expect(warnings[0]).toContain('"workflow"');
  });

  test("workflow mode does not warn", () => {
    const warnings: string[] = [];
    warnDeprecatedPipelineMode(configFor({ mode: "workflow", acceptance: false, advisor: true }), (m) =>
      warnings.push(m),
    );
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

  test("a root config with no execution.mode resolves to workflow mode", async () => {
    dir = mkdtempSync(join(tmpdir(), "nax-wf-"));
    mkdirSync(join(dir, ".nax"), { recursive: true });
    writeFileSync(join(dir, ".nax", "config.json"), JSON.stringify({ acceptance: { enabled: true } }));
    const cfg = await loadConfigForWorkdir(join(dir, ".nax", "config.json"));
    expect(cfg.execution.mode).toBe("workflow");
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
