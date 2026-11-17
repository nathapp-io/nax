/**
 * US-003: the same-head re-run's forge half. `sameHeadRerunFor` is what the workflow's own publish
 * hands the CI wait: a read of the head commit's failed checks and a re-run of one of them, through
 * the two `_deps` seams, so no test touches a real forge or needs `mock.module`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureContext } from "@test/helpers";
import type { FailedCheck, PrRef } from "@/forge";
import { _ciFailuresDeps, type CiFailuresInput } from "@/workflow/ci-failures";
import { _ciSameHeadDeps, sameHeadRerunFor } from "@/workflow/ci-same-head";
import type { FeatureContext } from "@/workflow/feature-context";

const saved = { same: { ..._ciSameHeadDeps }, failures: { ..._ciFailuresDeps } };
afterEach(() => {
  Object.assign(_ciSameHeadDeps, saved.same);
  Object.assign(_ciFailuresDeps, saved.failures);
});

const fc = makeFeatureContext({ projectDir: "/project" });
const GH_URL = "https://github.com/o/r/pull/9";
const GL_URL = "https://gitlab.com/g/p/-/merge_requests/9";
const GH_REF: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 9 };
const GL_REF: PrRef = { forge: "gitlab", host: "gitlab.com", repo: "g/p", number: 9 };

/** The forge calls the module makes, recorded instead of spawned. */
function fakeRun(reply: () => Promise<{ exitCode: number; stdout: string; stderr: string }>) {
  const calls: { cmd: string[]; cwd: string }[] = [];
  _ciSameHeadDeps.run = async (cmd, opts) => {
    calls.push({ cmd, cwd: opts.cwd });
    return await reply();
  };
  return calls;
}

const exits = (exitCode: number) => () => Promise.resolve({ exitCode, stdout: "", stderr: "" });

/** The PR resolution, recorded instead of run through the forge detect. */
function fakeRef(ref: PrRef) {
  const numbers: number[] = [];
  _ciFailuresDeps.resolvePrRef = async (number) => {
    numbers.push(number);
    return ref;
  };
  return numbers;
}

const rerunOf = (url: string) => sameHeadRerunFor(fc, url, "abc").rerun({ name: "test", jobId: "11", excerpt: "" });
const GITLAB_RERUN = ["glab", "api", "--hostname", "gitlab.com", "-X", "POST", "projects/g%2Fp/jobs/501/retry"];
const GITHUB_RERUN = ["gh", "api", "--hostname", "github.com", "-X", "POST", "repos/o/r/actions/jobs/11/rerun"];

describe("sameHeadRerunFor read", () => {
  test("AC-1: read() asks the injected reader for the URL and head, and returns its checks", async () => {
    const checks: readonly FailedCheck[] = [{ name: "test", excerpt: "", jobId: "11", passedOnSameHead: {} }];
    const seen: { fc: FeatureContext; input: CiFailuresInput }[] = [];
    _ciSameHeadDeps.readCiFailures = async (context, input) => {
      seen.push({ fc: context, input });
      return checks;
    };
    await expect(sameHeadRerunFor(fc, GH_URL, "abc").read()).resolves.toBe(checks);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.fc).toBe(fc);
    expect(seen[0]?.input).toEqual({ url: GH_URL, head: "abc" });
  });
});

describe("sameHeadRerunFor rerun", () => {
  test("AC-2: a GitHub PR re-runs the Actions job through the injected runner", async () => {
    const calls = fakeRun(exits(0));
    fakeRef(GH_REF);
    await expect(rerunOf(GH_URL)).resolves.toBe(true);
    expect(calls).toEqual([{ cmd: GITHUB_RERUN, cwd: "/project" }]);
  });

  test("AC-3: a GitLab MR retries the job through the injected runner", async () => {
    const calls = fakeRun(exits(0));
    fakeRef(GL_REF);
    await expect(sameHeadRerunFor(fc, GL_URL, "abc").rerun({ name: "test", jobId: "501", excerpt: "" })).resolves.toBe(
      true,
    );
    expect(calls).toEqual([{ cmd: GITLAB_RERUN, cwd: "/project" }]);
  });

  test("AC-4: a forge command that exits non-zero is a refused re-run", async () => {
    fakeRun(exits(1));
    fakeRef(GL_REF);
    await expect(rerunOf(GL_URL)).resolves.toBe(false);
  });

  test("AC-5: a check with no job id is refused before any forge call", async () => {
    const calls = fakeRun(exits(0));
    const numbers = fakeRef(GH_REF);
    await expect(sameHeadRerunFor(fc, GH_URL, "abc").rerun({ name: "test", excerpt: "" })).resolves.toBe(false);
    expect(calls).toEqual([]);
    expect(numbers).toEqual([]);
  });

  test("AC-6: the PR is resolved once across two re-runs", async () => {
    const calls = fakeRun(exits(0));
    const numbers = fakeRef(GH_REF);
    const rerun = sameHeadRerunFor(fc, GH_URL, "abc");
    await expect(rerun.rerun({ name: "a", jobId: "11", excerpt: "" })).resolves.toBe(true);
    await expect(rerun.rerun({ name: "b", jobId: "12", excerpt: "" })).resolves.toBe(true);
    expect(numbers).toEqual([9]);
    expect(calls).toHaveLength(2);
  });

  test("AC-7: an unresolvable PR is a refused re-run, with no forge call", async () => {
    const calls = fakeRun(exits(0));
    _ciFailuresDeps.resolvePrRef = async () => {
      throw new Error("no origin");
    };
    await expect(rerunOf(GH_URL)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  test("AC-18: a runner that throws is a refused re-run", async () => {
    fakeRun(() => {
      throw new Error("glab missing");
    });
    fakeRef(GL_REF);
    await expect(rerunOf(GL_URL)).resolves.toBe(false);
  });
});
