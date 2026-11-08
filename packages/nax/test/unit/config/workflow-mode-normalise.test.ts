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
  test("AC-1: an advisor that workflow mode turns on comes back enabled on a new config", () => {
    const cfg = configFor({ mode: "workflow", advisor: false });

    const out = applyWorkflowMode(cfg);

    expect(out.advisor?.enabled).toBe(true);
    expect(out).not.toBe(cfg);
  });

  test("AC-2: forcing the advisor on does not mutate the input config", () => {
    const cfg = configFor({ mode: "workflow", advisor: false });

    applyWorkflowMode(cfg);

    expect(cfg.advisor?.enabled).toBe(false);
  });

  test("AC-3: an advisor that is already enabled is returned as the same object reference", () => {
    const cfg = configFor({ mode: "workflow", advisor: true });

    expect(applyWorkflowMode(cfg)).toBe(cfg);
  });

  test("AC-14: a config with no advisor section is returned as the same object reference", () => {
    const cfg = configFor({ mode: "workflow" });
    Reflect.deleteProperty(cfg, "advisor");

    expect(cfg.advisor).toBeUndefined();
    expect(applyWorkflowMode(cfg)).toBe(cfg);
  });

  test("the shipped default config has its advisor forced on without being mutated", () => {
    expect(DEFAULT_CONFIG.advisor?.enabled).toBe(false);

    const out = applyWorkflowMode(DEFAULT_CONFIG);

    expect(out).not.toBe(DEFAULT_CONFIG);
    expect(out.advisor?.enabled).toBe(true);
    expect(DEFAULT_CONFIG.advisor?.enabled).toBe(false);
  });

  test("workflow mode no longer rewrites execution.storyIsolation", () => {
    // The isolation term is gone with the worktree execution path (US-004):
    // workflow mode forces only the advisor now.
    const cfg = makeNaxConfig({
      execution: { mode: "workflow", storyIsolation: "worktree" },
      advisor: { enabled: true },
    });

    expect(applyWorkflowMode(cfg)).toBe(cfg);
    expect(cfg.execution.storyIsolation).toBe("worktree");
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
