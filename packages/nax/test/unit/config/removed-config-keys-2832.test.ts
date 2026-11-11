import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  _clearRootConfigCache,
  loadConfig,
  loadConfigForWorkdir,
  loadPackageOverrideWithConfig,
} from "@/config/loader";
import * as removed from "@/config/removed-config-keys";
import { CURATOR_REMOVED_HINT, TESTING_POLICY_HINT } from "@/config/removed-config-keys";
import { addSink, initLogger, resetLogger } from "@/logger";

const curatorHint =
  "the curator feature was removed; nax no longer writes ~/.nax/global/curator, which is safe to delete";
const testingHint =
  "nothing reads this key since pipeline mode was removed; state test and mocking policy in a .nax/rules file";
const message = (path: string, hint: string) =>
  `Config key "${path}" has been removed — ${hint}. Remove it from your config.`;

function strip(raw: Record<string, unknown>) {
  const warnings: string[] = [];
  const result = removed.stripRemovedConfigKeys(raw, (msg) => warnings.push(msg));
  return { result, warnings };
}

describe("removed curator and pipeline keys", () => {
  test("AC-1: strips curator and warns once", () => {
    const { result, warnings } = strip({ curator: { enabled: true } });
    expect(result).toEqual({});
    expect(warnings).toEqual([message("curator", curatorHint)]);
  });
  test("AC-2: curator hint is exported", () => {
    expect(CURATOR_REMOVED_HINT).toBe(curatorHint);
  });
  test("AC-3: strips the testing section once", () => {
    const { result, warnings } = strip({ quality: { testing: { hermetic: true, mockGuidance: "x" } } });
    expect(result).toEqual({ quality: {} });
    expect(warnings).toEqual([message("quality.testing", testingHint)]);
  });
  test("AC-4: testing policy hint is exported", () => {
    expect(TESTING_POLICY_HINT).toBe(testingHint);
  });
  test("AC-5: warns for behavioral guardrails", () => {
    const { result, warnings } = strip({ prompts: { behavioralGuardrails: "strict" } });
    expect(result).toEqual({ prompts: {} });
    expect(warnings).toEqual([message("prompts.behavioralGuardrails", removed.PIPELINE_ONLY_KEY_HINT)]);
  });
  test("AC-6: strips nonBlockingFix", () => {
    const { result, warnings } = strip({ review: { nonBlockingFix: { enabled: true } } });
    expect(result).toEqual({ review: {} });
    expect(warnings).toEqual([message("review.nonBlockingFix", removed.PIPELINE_ONLY_KEY_HINT)]);
  });
  test("AC-7: warns for each review key", () => {
    const { result, warnings } = strip({
      review: { parseRetryMaxAttempts: 5, conflictDetection: { maxOscillations: 3 } },
    });
    expect(result).toEqual({ review: {} });
    expect(warnings.sort((a, b) => a.localeCompare(b))).toEqual(
      ["review.parseRetryMaxAttempts", "review.conflictDetection"]
        .map((p) => message(p, removed.PIPELINE_ONLY_KEY_HINT))
        .sort((a, b) => a.localeCompare(b)),
    );
  });
  test("AC-8: warns once per semantic key", () => {
    const { result, warnings } = strip({
      review: { semantic: { demandInspectionTrail: true, acRegroundOnDrop: true, recurrenceDemotion: true } },
    });
    expect(result).toEqual({ review: { semantic: {} } });
    expect(warnings.sort((a, b) => a.localeCompare(b))).toEqual(
      ["demandInspectionTrail", "acRegroundOnDrop", "recurrenceDemotion"]
        .map((p) => message(`review.semantic.${p}`, removed.PIPELINE_ONLY_KEY_HINT))
        .sort((a, b) => a.localeCompare(b)),
    );
  });
  test("AC-9: warns once per adversarial key", () => {
    const { result, warnings } = strip({
      review: {
        adversarial: {
          demandInspectionTrail: true,
          acRegroundOnDrop: true,
          recurrenceDemotion: true,
          parallel: true,
          maxConcurrentSessions: 3,
        },
      },
    });
    expect(result).toEqual({ review: { adversarial: {} } });
    expect(warnings.sort((a, b) => a.localeCompare(b))).toEqual(
      ["demandInspectionTrail", "acRegroundOnDrop", "recurrenceDemotion", "parallel", "maxConcurrentSessions"]
        .map((p) => message(`review.adversarial.${p}`, removed.PIPELINE_ONLY_KEY_HINT))
        .sort((a, b) => a.localeCompare(b)),
    );
  });
  test("AC-10: retains enabled beside removed parallel", () => {
    const { result, warnings } = strip({ review: { adversarial: { enabled: true, parallel: true } } });
    expect(result).toEqual({ review: { adversarial: { enabled: true } } });
    expect(warnings).toEqual([message("review.adversarial.parallel", removed.PIPELINE_ONLY_KEY_HINT)]);
  });
});

describe("removed keys through project loader", () => {
  let root: string;
  let globalDir: string;
  let previousGlobal: string | undefined;
  beforeEach(async () => {
    root = makeTempDir("removed-project-");
    globalDir = makeTempDir("removed-global-");
    previousGlobal = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    _clearRootConfigCache();
    await mkdir(join(root, ".nax"), { recursive: true });
  });
  afterEach(() => {
    if (previousGlobal === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = previousGlobal;
    resetLogger();
    cleanupTempDir(root);
    cleanupTempDir(globalDir);
  });
  async function load(raw: object) {
    await Bun.write(join(root, ".nax", "config.json"), JSON.stringify(raw));
    const warnings: string[] = [];
    resetLogger();
    initLogger({ level: "warn" });
    const removeSink = addSink((entry) => warnings.push(entry.message));
    try {
      return { config: await loadConfig(root), warnings };
    } finally {
      removeSink();
    }
  }
  test("AC-11 and AC-12: legacy path warns once as removed, never deprecated", async () => {
    const { config, warnings } = await load({ review: { adversarial: { nonBlockingFix: { enabled: true } } } });
    expect(warnings.filter((w) => w.includes("nonBlockingFix"))).toEqual([
      message("review.adversarial.nonBlockingFix", removed.PIPELINE_ONLY_KEY_HINT),
    ]);
    expect(config.review?.nonBlockingFix).toBeUndefined();
  });
  test("AC-12: legacy path never emits a deprecation warning", async () => {
    const { warnings } = await load({ review: { adversarial: { nonBlockingFix: { enabled: true } } } });
    expect(warnings.filter((w) => w.includes("is deprecated"))).toEqual([]);
  });
  test("default values do not produce removed-key warnings", async () => {
    const { warnings } = await load({});
    expect(warnings.filter((w) => w.startsWith("Config key "))).toEqual([]);
  });
  test("package loaders warn only for an explicitly configured removed key", async () => {
    await Bun.write(join(root, ".nax", "config.json"), "{}");
    const dir = join(root, ".nax", "mono", "app");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "config.json"), JSON.stringify({ review: { adversarial: { parallel: true } } }));
    const rootConfig = await loadConfig(root);
    for (const run of [
      () => loadConfigForWorkdir(join(root, ".nax", "config.json"), "app"),
      () => loadPackageOverrideWithConfig({ repoRoot: root, packageDir: "app", rootConfig }),
    ]) {
      const warnings: string[] = [];
      resetLogger();
      initLogger({ level: "warn" });
      const removeSink = addSink((entry) => warnings.push(entry.message));
      try {
        await run();
      } finally {
        removeSink();
      }
      expect(warnings.filter((w) => w.startsWith("Config key "))).toEqual([
        message("review.adversarial.parallel", removed.PIPELINE_ONLY_KEY_HINT),
      ]);
    }
  });
  test("AC-13: curator warns once and disabledPlugins survives", async () => {
    const { config, warnings } = await load({ curator: { enabled: true }, disabledPlugins: ["curator"] });
    expect(warnings.filter((w) => w.startsWith("Config key "))).toEqual([message("curator", curatorHint)]);
    expect(config.disabledPlugins).toEqual(["curator"]);
  });
});
