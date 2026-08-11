import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIELD_DESCRIPTIONS } from "../../../src/cli/config-descriptions";
import { stripRemovedNoOpKeys } from "../../../src/config/config-guards";
import {
  _clearRootConfigCache,
  loadConfig,
  loadConfigForWorkdir,
} from "../../../src/config/loader";
import { NaxConfigSchema } from "../../../src/config/schema";
import { InteractionChain } from "../../../src/interaction/chain";
import { _autoPluginDeps, AutoInteractionPlugin } from "../../../src/interaction/plugins/auto";
import type { InteractionRequest, InteractionResponse } from "../../../src/interaction/types";

const PACKAGE_ROOT = join(import.meta.dir, "../../..");
const REMOVED_KEYS = [
  "execution.rectification.escalateOnExhaustion",
  "tdd.autoVerifyIsolation",
  "tdd.autoApproveVerifier",
  "acceptance.generateTests",
] as const;

let tempDir = "";
let originalGlobalConfigDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync("/tmp/nax-retire-config-");
  originalGlobalConfigDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, "global", ".nax");
  _clearRootConfigCache();
});

afterEach(() => {
  _clearRootConfigCache();
  mock.restore();
  _autoPluginDeps.callLlm = undefined;
  if (originalGlobalConfigDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalConfigDir;
  rmSync(tempDir, { recursive: true, force: true });
});

function warnSpy(): ReturnType<typeof mock> {
  return mock(() => {});
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function makePrd(feature: string, stories: Array<{ id: string; title: string }>) {
  return {
    project: "acceptance-test",
    feature,
    branchName: `feat/${feature.toLowerCase().replaceAll(" ", "-")}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userStories: stories.map(({ id, title }) => ({
      id,
      title,
      description: title,
      acceptanceCriteria: ["works"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      attempts: 0,
      escalations: [],
    })),
  };
}

async function runStatus(project: string, feature: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", "bin/nax.ts", "status", "--dir", project, "--feature", feature], {
    cwd: PACKAGE_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: `${stdout}${stderr}` };
}

function createStatusProject(feature: string, stories: Array<{ id: string; title: string }>): { project: string; featureDir: string } {
  const project = join(tempDir, "project");
  const featureDir = join(project, ".nax", "features", feature);
  // Pin `outputDir` to the project's `.nax` dir so the status command resolves
  // the feature dir here (its default `globalConfigDir()/projectKey` would
  // otherwise look in a temp-global location with no prd.json).
  writeJson(join(project, ".nax", "config.json"), { outputDir: join(project, ".nax") });
  writeJson(join(featureDir, "prd.json"), makePrd(feature, stories));
  return { project, featureDir };
}

describe("retire-dead-cli-config-surface acceptance", () => {
  test("AC-1: warns once for every removed no-op key", () => {
    const warn = warnSpy();
    stripRemovedNoOpKeys({
      execution: { rectification: { escalateOnExhaustion: true } },
      tdd: { autoVerifyIsolation: false, autoApproveVerifier: true },
      acceptance: { generateTests: false },
    }, warn);
    expect(warn.mock.calls).toHaveLength(4);
    const messages = warn.mock.calls.map(([message]) => String(message));
    for (const key of REMOVED_KEYS) expect(messages.some((message) => message.includes(key))).toBe(true);
  });

  test("AC-2: strips tdd.autoVerifyIsolation without mutating input", () => {
    const input = { tdd: { autoVerifyIsolation: true, maxRetries: 3 } };
    const result = stripRemovedNoOpKeys(input, warnSpy());
    expect(result.tdd).toEqual({ maxRetries: 3 });
    expect(input.tdd.autoVerifyIsolation).toBe(true);
  });

  test("AC-3: leaves a config with no removed keys unchanged", () => {
    const input = { execution: { timeout: 3000 }, tdd: { maxRetries: 3 } };
    const warn = warnSpy();
    expect(JSON.stringify(stripRemovedNoOpKeys(input, warn))).toBe(JSON.stringify(input));
    expect(warn.mock.calls).toHaveLength(0);
  });

  test("AC-4: preserves tdd siblings while stripping the removed key", () => {
    const result = stripRemovedNoOpKeys({ tdd: { autoVerifyIsolation: false, maxRetries: 5 } }, warnSpy());
    expect(result.tdd).toEqual({ maxRetries: 5 });
  });

  test("AC-5: preserves acceptance.enabled while stripping generateTests", () => {
    const result = stripRemovedNoOpKeys({ acceptance: { generateTests: false, enabled: true } }, warnSpy());
    expect(result.acceptance).toEqual({ enabled: true });
  });

  test("AC-6: preserves rectification siblings while stripping escalateOnExhaustion", () => {
    const result = stripRemovedNoOpKeys(
      { execution: { rectification: { escalateOnExhaustion: true, abortOnNoProgress: 10 } } },
      warnSpy(),
    );
    expect(result.execution).toEqual({ rectification: { abortOnNoProgress: 10 } });
  });

  test("AC-7: accepts configs without tdd and does not warn", () => {
    const input = { execution: { timeout: 3000 } };
    const warn = warnSpy();
    expect(stripRemovedNoOpKeys(input, warn)).toEqual(input);
    expect(warn.mock.calls).toHaveLength(0);
  });

  test("AC-8: leaves non-object tdd values untouched", () => {
    const warn = warnSpy();
    const result = stripRemovedNoOpKeys({ tdd: 42 }, warn);
    expect(result.tdd).toBe(42);
    expect(warn.mock.calls).toHaveLength(0);
  });

  test("AC-9: strips a removed key regardless of its value type", () => {
    const warn = warnSpy();
    const result = stripRemovedNoOpKeys({ tdd: { autoVerifyIsolation: "yes" } }, warn);
    expect(result.tdd).toEqual({});
    expect(warn.mock.calls).toHaveLength(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("tdd.autoVerifyIsolation");
  });

  test("AC-10: strips removed keys from project config", async () => {
    const project = join(tempDir, "project");
    writeJson(join(project, ".nax", "config.json"), { tdd: { autoVerifyIsolation: false } });
    const result = await loadConfig(project);
    expect(result.tdd).not.toHaveProperty("autoVerifyIsolation");
  });

  test("AC-11: strips removed keys from global config", async () => {
    writeJson(join(process.env.NAX_GLOBAL_CONFIG_DIR!, "config.json"), { acceptance: { generateTests: false } });
    const project = join(tempDir, "no-project-config");
    mkdirSync(project, { recursive: true });
    const result = await loadConfig(project);
    expect(result.acceptance).not.toHaveProperty("generateTests");
  });

  test("AC-12: strips a removed key after global and project layers merge", async () => {
    writeJson(join(process.env.NAX_GLOBAL_CONFIG_DIR!, "config.json"), {
      execution: { rectification: { escalateOnExhaustion: true } },
    });
    const project = join(tempDir, "project");
    writeJson(join(project, ".nax", "config.json"), {
      execution: { rectification: { escalateOnExhaustion: true } },
    });
    const result = await loadConfig(project);
    expect(result.execution.rectification).not.toHaveProperty("escalateOnExhaustion");
  });

  test("AC-13: strips removed keys from per-package config", async () => {
    const project = join(tempDir, "monorepo");
    const rootConfig = join(project, ".nax", "config.json");
    writeJson(rootConfig, {});
    writeJson(join(project, ".nax", "mono", "packages", "api", "config.json"), {
      tdd: { autoApproveVerifier: true },
    });
    const result = await loadConfigForWorkdir(rootConfig, "packages/api");
    expect(result.tdd).not.toHaveProperty("autoApproveVerifier");
  });

  test("AC-14: schema defaults omit rectification.escalateOnExhaustion", () => {
    expect(NaxConfigSchema.parse({}).execution.rectification).not.toHaveProperty("escalateOnExhaustion");
  });

  test("AC-15: schema defaults omit tdd.autoVerifyIsolation", () => {
    expect(NaxConfigSchema.parse({}).tdd).not.toHaveProperty("autoVerifyIsolation");
  });

  test("AC-16: schema defaults omit tdd.autoApproveVerifier", () => {
    expect(NaxConfigSchema.parse({}).tdd).not.toHaveProperty("autoApproveVerifier");
  });

  test("AC-17: schema defaults omit acceptance.generateTests", () => {
    expect(NaxConfigSchema.parse({}).acceptance).not.toHaveProperty("generateTests");
  });

  test("AC-18: descriptions omit execution.rectification.escalateOnExhaustion", () => {
    expect(FIELD_DESCRIPTIONS["execution.rectification.escalateOnExhaustion"]).toBeUndefined();
  });

  test("AC-19: descriptions omit tdd.autoVerifyIsolation", () => {
    expect(FIELD_DESCRIPTIONS["tdd.autoVerifyIsolation"]).toBeUndefined();
  });

  test("AC-20: descriptions omit tdd.autoApproveVerifier", () => {
    expect(FIELD_DESCRIPTIONS["tdd.autoApproveVerifier"]).toBeUndefined();
  });

  test("AC-21: descriptions omit acceptance.generateTests", () => {
    expect(FIELD_DESCRIPTIONS["acceptance.generateTests"]).toBeUndefined();
  });

  test("AC-22: descriptions retain acceptance.enabled", () => {
    const description = FIELD_DESCRIPTIONS["acceptance.enabled"];
    expect(typeof description).toBe("string");
    expect(description.length).toBeGreaterThan(0);
  });

  test("AC-23: status omits removed pending-interaction output", async () => {
    const { project, featureDir } = createStatusProject("User Authentication", [{ id: "S1", title: "Setup auth flow" }]);
    writeJson(join(featureDir, "interactions", "pending.json"), {
      id: "00000000-0000-4000-8000-000000000001", type: "review", featureName: "User Authentication",
      stage: "review", summary: "Review", fallback: "skip", createdAt: Date.now(),
    });
    const result = await runStatus(project, "User Authentication");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Waiting for Interaction");
  });

  test("AC-24: status displays the PRD feature name", async () => {
    const { project } = createStatusProject("User Authentication", [{ id: "S1", title: "Setup auth flow" }]);
    const result = await runStatus(project, "User Authentication");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("User Authentication");
  });

  test("AC-25: status displays each PRD story id and title", async () => {
    const { project } = createStatusProject("Authentication", [
      { id: "S1", title: "Setup auth flow" },
      { id: "S2", title: "Add login endpoint" },
    ]);
    const result = await runStatus(project, "Authentication");
    expect(result.exitCode).toBe(0);
    for (const text of ["S1", "S2", "Setup auth flow", "Add login endpoint"]) expect(result.stdout).toContain(text);
  });

  test("AC-26: in-process human-review resolution preserves request id", async () => {
    const requestId = "00000000-0000-4000-8000-000000000026";
    const chain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "skip" });
    const plugin = new AutoInteractionPlugin();
    chain.register(plugin);
    await plugin.init({ confidenceThreshold: 0.7 });
    _autoPluginDeps.callLlm = mock(async () => ({ action: "approve" as const, confidence: 1, reasoning: "safe" }));
    const request: InteractionRequest = {
      id: requestId, type: "review", featureName: "Authentication", stage: "review", summary: "Human review",
      fallback: "skip", createdAt: Date.now(), metadata: { trigger: "human-review" },
    };
    const response: InteractionResponse | undefined = await plugin.decide(request);
    expect(response).toBeDefined();
    expect(response?.requestId).toBe(requestId);
    expect(typeof response?.action).toBe("string");
    expect(response?.respondedAt).toBeGreaterThan(0);
  });
});