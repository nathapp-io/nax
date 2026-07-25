import { afterEach, describe, expect, test } from "bun:test";
import { _contextDeps, detectBaseBranch, preflight, resolveFeature } from "@flows/nax-finish/steps/context";
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

  test("resolveFeature returns the spec source and the acceptance groups from one resolve call", async () => {
    let calls = 0;
    _contextDeps.run = async () => {
      calls += 1;
      return ok(
        JSON.stringify({
          status: "ok",
          featureName: "x",
          specSource: { kind: "prd", path: ".nax/features/x/prd.json" },
          acceptance: {
            status: "ok",
            groups: [
              {
                packageDir: "apps/web",
                testPath: "apps/web/.nax/features/x/a.test.tsx",
                exists: true,
                language: "typescript",
              },
            ],
          },
        }),
      );
    };
    const r = await resolveFeature("x", "/w");
    expect(calls).toBe(1);
    expect(r.specPath).toBe(".nax/features/x/prd.json");
    expect(r.specKind).toBe("prd");
    expect(r.acceptanceStatus).toBe("ok");
    expect(r.groups[0].packageDir).toBe("apps/web");
  });

  test("resolveFeature defaults acceptance to no-prd with no groups when absent", async () => {
    _contextDeps.run = async () =>
      ok(JSON.stringify({ status: "ok", specSource: { kind: "markdown", path: ".nax/features/x/spec.md" } }));
    const r = await resolveFeature("x", "/w");
    expect(r.acceptanceStatus).toBe("no-prd");
    expect(r.groups).toEqual([]);
  });

  test("resolveFeature throws when specSource is missing", async () => {
    _contextDeps.run = async () => ok(JSON.stringify({ status: "no-prd", featureName: "x" }));
    await expect(resolveFeature("x", "/w")).rejects.toThrow('no specSource for "x"');
  });

  test("resolveFeature throws a coded error on unparseable stdout instead of a raw SyntaxError", async () => {
    _contextDeps.run = async () => ({ exitCode: 1, stdout: "command not found", stderr: "" });
    await expect(resolveFeature("x", "/w")).rejects.toThrow(/unparseable JSON/);
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
