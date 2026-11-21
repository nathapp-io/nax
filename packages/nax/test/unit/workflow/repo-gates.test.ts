import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeFeatureContext, makeNaxConfig, waitForFile, withTempDir } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";
import { _qualityGateDeps, resolveGateCommands } from "@/finish";
import type { GateCommand } from "@/finish/gates/quality";
import { qualityLogsAreQuiet } from "@/quality/log-scope";
import { _featureDeps } from "@/workflow/feature-deps";
import { gateExcerpt, runRepoGates } from "@/workflow/repo-gates";

const original = { ..._featureDeps };
const originalQuality = { ..._qualityGateDeps };
afterEach(() => {
  Object.assign(_featureDeps, original);
  Object.assign(_qualityGateDeps, originalQuality);
});

describe("gateExcerpt", () => {
  test("the named gate's chunk, without its header line", () => {
    const out = "[build] exit=0\nok\n\n[lint] exit=1\nsrc/a.ts:1 no-var\nsrc/b.ts:2 eqeqeq";
    expect(gateExcerpt(out, "lint")).toBe("src/a.ts:1 no-var\nsrc/b.ts:2 eqeqeq");
    expect(gateExcerpt(out, "test")).toBe("");
  });

  test("keeps only the last 40 lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const excerpt = gateExcerpt(`[test] exit=1\n${lines.join("\n")}`, "test");
    expect(excerpt.split("\n")).toHaveLength(40);
    expect(excerpt.endsWith("line 99")).toBe(true);
  });
});

describe("runRepoGates", () => {
  test("US-003 AC-9: real resolver sends only root test to the workflow gate runner", async () => {
    const fc = makeFeatureContext({ packageDirs: ["packages/api"] });
    const seen: GateCommand[][] = [];
    _featureDeps.resolveGateCommands = resolveGateCommands;
    _qualityGateDeps.loadConfig = async (root) => {
      expect(root).toBe(fc.projectDir);
      return makeNaxConfig({ quality: { commands: { test: "root test" } } });
    };
    _qualityGateDeps.loadPackageOverride = async (root, packageDir) => {
      expect(root).toBe(fc.projectDir);
      expect(packageDir).toBe("packages/api");
      return { quality: { ...DEFAULT_CONFIG.quality, commands: { test: "api test" } } };
    };
    _featureDeps.runQualityGates = async (_root, commands) => {
      seen.push(commands);
      return { passed: true, ran: commands.map((c) => c.name), failing: [], output: "" };
    };

    await runRepoGates(fc);

    const expected: GateCommand[] = [
      {
        name: "test",
        command: "root test",
        cwd: fc.projectDir,
        stallDetection: DEFAULT_CONFIG.quality.stallDetection,
      },
    ];
    expect(seen).toEqual([expected]);
  });

  test("runs the gates inside the quiet-quality scope (the step line says the result)", async () => {
    let quiet: boolean | undefined;
    _featureDeps.resolveGateCommands = async () => [];
    _featureDeps.runQualityGates = async () => {
      quiet = qualityLogsAreQuiet();
      return { passed: true, ran: ["build"], failing: [], output: "" };
    };
    await runRepoGates(makeFeatureContext());
    expect(quiet).toBe(true);
  });

  test("passes the feature's package dirs; one finding per failing gate", async () => {
    const seen: string[][] = [];
    _featureDeps.resolveGateCommands = async (_root, packageDirs) => {
      seen.push(packageDirs);
      return [];
    };
    _featureDeps.runQualityGates = async () => ({
      passed: false,
      ran: ["build", "lint"],
      failing: ["lint"],
      output: "[build] exit=0\n\n[lint] exit=1\nno-var",
    });
    const run = await runRepoGates(makeFeatureContext({ packageDirs: ["packages/api"] }));
    expect(seen).toEqual([["packages/api"]]);
    expect(run.summary).toEqual({ ran: ["build", "lint"], failing: ["lint"] });
    expect(run.findings).toEqual([{ kind: "gate", severity: "important", issue: "repo gate lint failed:\nno-var" }]);
  });

  test("nothing configured: nothing ran, no findings (a draft reason later, not a red gate)", async () => {
    _featureDeps.resolveGateCommands = async () => [];
    _featureDeps.runQualityGates = async () => ({ passed: false, ran: [], failing: [], output: "nothing" });
    expect(await runRepoGates(makeFeatureContext())).toEqual({ summary: { ran: [], failing: [] }, findings: [] });
  });

  test("US-002 AC-7: passes fc.runSignal to runQualityGates", async () => {
    const ac = new AbortController();
    let third: { signal?: AbortSignal } | undefined;
    _featureDeps.resolveGateCommands = async () => [];
    _featureDeps.runQualityGates = async (_r, _c, opts) => {
      third = opts;
      return { passed: true, ran: [], failing: [], output: "" };
    };
    await runRepoGates(makeFeatureContext({ runSignal: ac.signal }));
    expect(third?.signal).toBe(ac.signal);
  });

  test("US-002 AC-8: no runSignal means no signal key", async () => {
    let third: object | undefined = { sentinel: true };
    _featureDeps.resolveGateCommands = async () => [];
    _featureDeps.runQualityGates = async (_r, _c, opts) => {
      third = opts;
      return { passed: true, ran: [], failing: [], output: "" };
    };
    await runRepoGates(makeFeatureContext());
    expect(third === undefined || !("signal" in third)).toBe(true);
  });

  test("US-002 AC-9: an abort rejection is rethrown as the same error", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = new NaxError("aborted", "QUALITY_GATES_ABORTED", { stage: "quality-gates" });
    _featureDeps.resolveGateCommands = async () => [];
    _featureDeps.runQualityGates = async () => {
      throw err;
    };
    await expect(runRepoGates(makeFeatureContext({ runSignal: ac.signal }))).rejects.toBe(err);
  });

  test("US-002 AC-10: aborting during lint stops test and e2e from starting", async () => {
    await withTempDir(async (dir) => {
      const ac = new AbortController();
      const gate = (name: string, command: string): GateCommand => ({ name, command, cwd: dir });
      _featureDeps.resolveGateCommands = async () => [
        gate(
          "lint",
          "touch lint-started; i=0; while [ ! -f resume ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done",
        ),
        gate("test", "touch test-started"),
        gate("e2e", "touch e2e-started"),
      ];
      const running = runRepoGates(makeFeatureContext({ projectDir: dir, runSignal: ac.signal }));
      const settled = running.then(
        () => "resolved",
        () => "rejected",
      );
      await waitForFile(join(dir, "lint-started"), 10_000);
      ac.abort();
      expect(await settled).toBe("rejected");
      expect(existsSync(join(dir, "test-started"))).toBe(false);
      expect(existsSync(join(dir, "e2e-started"))).toBe(false);
    });
  }, 30_000);

  test("a gate runner throw becomes one red repo-gates finding; abort rethrows", async () => {
    _featureDeps.resolveGateCommands = async () => {
      throw new Error("config load failed");
    };
    const run = await runRepoGates(makeFeatureContext());
    expect(run.summary.failing).toEqual(["repo-gates"]);
    expect(run.findings[0]?.issue).toContain("config load failed");
    const ac = new AbortController();
    ac.abort();
    await expect(runRepoGates(makeFeatureContext({ runSignal: ac.signal }))).rejects.toThrow("config load failed");
  });
});
