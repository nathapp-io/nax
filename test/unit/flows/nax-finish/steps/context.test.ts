import { afterEach, describe, expect, test } from "bun:test";
import { _contextDeps, detectBaseBranch, preflight, resolveSpec } from "@flows/nax-finish/steps/context";
import type { RunResult } from "@flows/nax-finish/types";

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "" });
const originalRun = _contextDeps.run;
afterEach(() => {
  _contextDeps.run = originalRun;
});

describe("context steps", () => {
  test("detectBaseBranch parses 'HEAD branch'", async () => {
    _contextDeps.run = async () => ok("  HEAD branch: main\n");
    expect(await detectBaseBranch("/w")).toBe("origin/main");
  });

  test("detectBaseBranch falls back to origin/main verify when HEAD branch is unparseable", async () => {
    _contextDeps.run = async (cmd: string[]) =>
      cmd.join(" ").includes("rev-parse") ? ok("") : ok("no HEAD branch line here\n");
    expect(await detectBaseBranch("/w")).toBe("origin/main");
  });

  test("detectBaseBranch falls back to origin/master when origin/main verify fails", async () => {
    _contextDeps.run = async (cmd: string[]) =>
      cmd.join(" ").includes("rev-parse") ? { exitCode: 1, stdout: "", stderr: "" } : ok("no HEAD branch line here\n");
    expect(await detectBaseBranch("/w")).toBe("origin/master");
  });

  test("resolveSpec reads specSource from nax features resolve --json", async () => {
    _contextDeps.run = async () =>
      ok(
        JSON.stringify({
          status: "ok",
          featureName: "x",
          specSource: { kind: "prd", path: ".nax/features/x/prd.json" },
        }),
      );
    expect(await resolveSpec("x", "/w")).toEqual({ specPath: ".nax/features/x/prd.json", specKind: "prd" });
  });

  test("resolveSpec throws NaxError when specSource is missing", async () => {
    _contextDeps.run = async () => ok(JSON.stringify({ status: "no-prd", featureName: "x" }));
    await expect(resolveSpec("x", "/w")).rejects.toThrow('no specSource for "x"');
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
