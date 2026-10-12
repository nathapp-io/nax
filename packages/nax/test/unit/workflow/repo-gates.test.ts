import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureContext } from "@test/helpers";
import { _featureDeps } from "@/workflow/feature-deps";
import { gateExcerpt, runRepoGates } from "@/workflow/repo-gates";

const original = { ..._featureDeps };
afterEach(() => Object.assign(_featureDeps, original));

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
