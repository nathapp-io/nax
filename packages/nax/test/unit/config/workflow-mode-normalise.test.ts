import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { _clearRootConfigCache, loadConfigForWorkdir } from "@/config/loader";
import { applyWorkflowMode } from "@/config/workflow-mode";

type Mode = "pipeline" | "workflow";

function configFor(opts: { mode?: Mode; advisor?: boolean }): NaxConfig {
  return makeNaxConfig({
    execution: { mode: opts.mode ?? "pipeline" },
    ...(opts.advisor === undefined ? {} : { advisor: { enabled: opts.advisor } }),
  });
}

describe("applyWorkflowMode", () => {
  test("AC-12 normalizes hand-built pipeline configs too", () => {
    const cfg = makeNaxConfig({
      execution: { mode: "pipeline", storyIsolation: "worktree" },
      advisor: { enabled: false },
    });
    const out = applyWorkflowMode(cfg, () => {});
    expect(out.execution.storyIsolation).toBe("shared");
    expect(out.advisor?.enabled).toBe(true);
  });

  test("workflow mode forces the advisor on, silently when it is the shipped default", () => {
    const cfg = configFor({ mode: "workflow", advisor: false });
    const warnings: string[] = [];
    const out = applyWorkflowMode(cfg, (m) => warnings.push(m));
    expect(out.advisor?.enabled).toBe(true);
    expect(cfg.advisor?.enabled).toBe(false); // input not mutated
    // workflow is the default mode, so overriding untouched defaults is not news on every run
    expect(warnings).toEqual([]);
  });

  test("the shipped default config resolves in workflow mode without a warning", () => {
    const warnings: string[] = [];
    applyWorkflowMode(DEFAULT_CONFIG, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  test("workflow mode forces shared story isolation: the workflow tree sits in the main checkout (nax#2479)", () => {
    const cfg = makeNaxConfig({
      execution: { mode: "workflow", storyIsolation: "worktree" },
      advisor: { enabled: true },
    });
    const warnings: string[] = [];
    const out = applyWorkflowMode(cfg, (m) => warnings.push(m));
    expect(out.execution.storyIsolation).toBe("shared");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("execution.storyIsolation=shared");
  });

  test("workflow mode with keys already at their forced values does not warn", () => {
    const cfg = configFor({ mode: "workflow", advisor: true });
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

describe("applyWorkflowMode at the per-package loader exit", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
    _clearRootConfigCache();
  });

  test("a package override cannot re-enable worktree isolation in workflow mode", async () => {
    dir = mkdtempSync(join(tmpdir(), "nax-wf-"));
    mkdirSync(join(dir, ".nax", "mono", "apps", "api"), { recursive: true });
    writeFileSync(join(dir, ".nax", "config.json"), JSON.stringify({ execution: { mode: "workflow" } }));
    writeFileSync(
      join(dir, ".nax", "mono", "apps", "api", "config.json"),
      JSON.stringify({ execution: { storyIsolation: "worktree" } }),
    );
    const cfg = await loadConfigForWorkdir(join(dir, ".nax", "config.json"), "apps/api");
    expect(cfg.execution.storyIsolation).toBe("shared");
  });

  test("a root config with no execution.mode resolves to workflow mode", async () => {
    dir = mkdtempSync(join(tmpdir(), "nax-wf-"));
    mkdirSync(join(dir, ".nax"), { recursive: true });
    writeFileSync(join(dir, ".nax", "config.json"), JSON.stringify({ version: 1 }));
    const cfg = await loadConfigForWorkdir(join(dir, ".nax", "config.json"));
    expect(cfg.execution.mode).toBe("workflow");
  });

  test("a root config in workflow mode resolves with the advisor on", async () => {
    dir = mkdtempSync(join(tmpdir(), "nax-wf-"));
    mkdirSync(join(dir, ".nax"), { recursive: true });
    writeFileSync(
      join(dir, ".nax", "config.json"),
      JSON.stringify({ execution: { mode: "workflow" }, advisor: { enabled: false } }),
    );
    const cfg = await loadConfigForWorkdir(join(dir, ".nax", "config.json"));
    expect(cfg.advisor?.enabled).toBe(true);
  });
});
