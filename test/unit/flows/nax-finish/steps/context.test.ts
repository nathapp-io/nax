import { afterEach, describe, expect, test } from "bun:test";
import { _contextDeps, detectBaseBranch, resolveSpec, preflight } from "@flows/nax-finish/steps/context";
import type { RunResult } from "@flows/nax-finish/types";

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "" });
afterEach(() => { _contextDeps.run = _contextDeps.run; });

describe("context steps", () => {
  test("detectBaseBranch parses 'HEAD branch'", async () => {
    _contextDeps.run = async () => ok("  HEAD branch: main\n");
    expect(await detectBaseBranch("/w")).toBe("origin/main");
  });

  test("resolveSpec reads specSource from nax features resolve --json", async () => {
    _contextDeps.run = async () => ok(JSON.stringify({ status: "ok", featureName: "x", specSource: { kind: "prd", path: ".nax/features/x/prd.json" } }));
    expect(await resolveSpec("x", "/w")).toEqual({ specPath: ".nax/features/x/prd.json", specKind: "prd" });
  });

  test("preflight routes nothing-to-finish at 0 commits ahead", async () => {
    _contextDeps.run = async () => ok("0\n");
    expect(await preflight("/w", "origin/main")).toEqual({ commitsAhead: 0, route: "nothing-to-finish" });
  });

  test("preflight routes proceed when ahead", async () => {
    _contextDeps.run = async () => ok("3\n");
    expect(await preflight("/w", "origin/main")).toEqual({ commitsAhead: 3, route: "proceed" });
  });
});
