import { afterEach, describe, expect, test } from "bun:test";
import {
  _contextDeps,
  detectBaseBranch,
  partitionTestFiles,
  preflight,
  resolveFeature,
} from "@flows/nax-finish/steps/context";
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

  test("resolveFeature degrades an unrecognised acceptance status to no-prd", async () => {
    // A status this flow does not know cannot be reasoned about: it is neither
    // the explicit opt-out nor a resolution we can trust. `no-prd` is the one
    // value that routes to `escalate`, which is the honest answer — the same
    // posture as the missing-status default just above.
    _contextDeps.run = async () =>
      ok(
        JSON.stringify({
          specSource: { kind: "markdown", path: ".nax/features/x/spec.md" },
          acceptance: { status: "partially-resolved", groups: [] },
        }),
      );
    const r = await resolveFeature("x", "/w");
    expect(r.acceptanceStatus).toBe("no-prd");
  });

  test("resolveFeature passes through every status the flow actually branches on", async () => {
    for (const status of ["ok", "no-prd", "disabled"] as const) {
      _contextDeps.run = async () =>
        ok(
          JSON.stringify({
            specSource: { kind: "markdown", path: ".nax/features/x/spec.md" },
            acceptance: { status, groups: [] },
          }),
        );
      const r = await resolveFeature("x", "/w");
      expect(r.acceptanceStatus).toBe(status);
    }
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

  // `detectBaseBranch`'s last-resort `origin/master` is returned unverified, so
  // a repo whose base ref is not fetched locally fails this count. Parsing the
  // empty stdout gave `NaN || 0` — indistinguishable from a branch with no new
  // commits — and the flow reported `nothing-to-finish` having reviewed,
  // verified and pushed nothing.
  test("preflight escalates when the base ref cannot be resolved, rather than reading it as 0 commits", async () => {
    _contextDeps.run = async () => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: ambiguous argument 'origin/master..HEAD': unknown revision",
    });
    const r = await preflight("/w", "origin/master");
    expect(r.route).toBe("escalate");
    expect(r.commitsAhead).toBe(0);
    expect(r.reason).toContain("origin/master");
    expect(r.reason).toContain("unknown revision");
  });

  test("preflight escalates on unreadable output from a zero exit", async () => {
    _contextDeps.run = async () => ok("not-a-number\n");
    const r = await preflight("/w", "origin/main");
    expect(r.route).toBe("escalate");
    expect(r.reason).toContain("not-a-number");
  });
});

describe("partitionTestFiles", () => {
  const TS = ["\\.test\\.ts$", "(^|/)test/"];

  test("splits by the resolver's patterns", () => {
    const r = partitionTestFiles(["src/a.ts", "test/unit/a.test.ts", "apps/api/tests/b.py"], TS);
    expect(r.test).toEqual(["test/unit/a.test.ts"]);
    expect(r.nonTest).toEqual(["src/a.ts", "apps/api/tests/b.py"]);
  });

  // The one caller skips its re-review only on a test-only change, so
  // "cannot classify" must mean "review it", never "skip it".
  test("no patterns means nothing is classified as a test", () => {
    const r = partitionTestFiles(["test/unit/a.test.ts"], []);
    expect(r.test).toEqual([]);
    expect(r.nonTest).toEqual(["test/unit/a.test.ts"]);
  });

  test("an unparseable pattern is skipped, the valid ones still apply", () => {
    const r = partitionTestFiles(["test/unit/a.test.ts", "src/a.ts"], ["([unclosed", "\\.test\\.ts$"]);
    expect(r.test).toEqual(["test/unit/a.test.ts"]);
    expect(r.nonTest).toEqual(["src/a.ts"]);
  });

  test("an all-bad pattern list degrades to non-test, not to a throw", () => {
    expect(partitionTestFiles(["test/a.test.ts"], ["([unclosed"]).nonTest).toEqual(["test/a.test.ts"]);
  });

  test("an empty path list yields two empty buckets", () => {
    expect(partitionTestFiles([], TS)).toEqual({ test: [], nonTest: [] });
  });
});
