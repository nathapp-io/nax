import { describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, PrRef } from "@/forge";
import * as forge from "@/forge";

const ESC = "\u001b";

describe("prNumberFromUrl", () => {
  test.each([
    ["AC-1", "https://github.com/o/r/pull/42", 42],
    ["AC-2", "https://gitlab.com/g/p/-/merge_requests/7", 7],
    ["AC-3", "https://github.com/o/r/pull/42/files", 42],
    ["AC-4", "https://github.com/o/r/issues/42", null],
  ] as const)("%s reads the pull-request number of a forge URL", (_ac, url, expected) => {
    expect(forge.prNumberFromUrl(url)).toBe(expected);
  });

  test.each([
    ["a query string", "https://github.com/o/r/pull/42?foo=1", 42],
    ["a fragment", "https://github.com/o/r/pull/42#issuecomment-1", 42],
    ["a trailing slash", "https://github.com/o/r/pull/42/", 42],
    ["no number", "https://github.com/o/r/pull/", null],
    ["a non-numeric number", "https://github.com/o/r/pull/abc", null],
    ["a number glued to text", "https://github.com/o/r/pull/42x", null],
    ["an empty string", "", null],
  ] as const)("reads %s as %s", (_case, url, expected) => {
    expect(forge.prNumberFromUrl(url)).toBe(expected);
  });
});

describe("ciExcerpt", () => {
  test("AC-5 keeps the text of an ANSI-coloured failure", () => {
    expect(forge.ciExcerpt(`build ${ESC}[31mfail${ESC}[0m now`)).toContain("fail");
  });

  test("AC-6 removes every ESC character", () => {
    expect(forge.ciExcerpt(`build ${ESC}[31mfail${ESC}[0m now`)).not.toContain(ESC);
  });

  test("AC-7 keeps the last 200 lines of a 500-line log", () => {
    const log = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = forge.ciExcerpt(log).split("\n");
    expect(lines).toHaveLength(forge.CI_EXCERPT_LINES);
    expect(lines[0]).toBe("line 301");
    expect(lines[lines.length - 1]).toBe("line 500");
  });

  test("AC-8 keeps the last 8000 characters of one long line", () => {
    const excerpt = forge.ciExcerpt("x".repeat(20_000));
    expect(excerpt).toHaveLength(forge.CI_EXCERPT_CHARS);
    expect(excerpt).toBe("x".repeat(forge.CI_EXCERPT_CHARS));
  });

  test("AC-9 redacts a token out of the log", () => {
    const excerpt = forge.ciExcerpt("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(excerpt).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });

  test("keeps a short log whole", () => {
    expect(forge.ciExcerpt("one\ntwo\nthree")).toBe("one\ntwo\nthree");
  });
});

const gh: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 42 };
const LISTING_ARGV = [
  "gh",
  "api",
  "--hostname",
  "github.com",
  "repos/o/r/commits/abc123/check-runs?per_page=100&filter=latest",
];

interface CheckRun {
  readonly id?: number;
  readonly name?: string;
  readonly conclusion?: string | null;
  readonly html_url?: string;
  readonly app?: { readonly slug?: string };
  readonly output?: { readonly title?: string; readonly summary?: string; readonly text?: string };
}

function checkRun(overrides: CheckRun = {}): CheckRun {
  return { id: 1, name: "build", conclusion: "failure", ...overrides };
}

/** A forge whose `gh api` call answers with `runs` and whose job logs answer from `logs`. */
function githubFixture(runs: readonly CheckRun[], logs: Readonly<Record<string, string>> = {}) {
  const calls: { cmd: string[]; cwd: string }[] = [];
  const deps: ForgeDeps = {
    run: async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd });
      if (cmd[1] === "api") return { exitCode: 0, stdout: JSON.stringify({ check_runs: runs }), stderr: "" };
      const jobIndex = cmd.indexOf("--job");
      const jobId = jobIndex >= 0 ? (cmd[jobIndex + 1] ?? "") : "";
      return { exitCode: 0, stdout: logs[jobId] ?? "", stderr: "" };
    },
    readText: async () => null,
  };
  return { deps, calls };
}

describe("readFailedChecks", () => {
  test("AC-10 reads the check runs of the head commit first", async () => {
    const { deps, calls } = githubFixture([]);
    await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(calls[0]?.cmd).toEqual(LISTING_ARGV);
    expect(calls[0]?.cwd).toBe("/repo");
  });

  test.each(["failure", "timed_out", "action_required", "cancelled"])(
    "AC-11 lists a %s check run as failed",
    async (conclusion) => {
      const { deps } = githubFixture([checkRun({ id: 7, name: "build", conclusion })]);
      const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
      expect(checks).toHaveLength(1);
      expect(checks[0]?.name).toBe("build");
    },
  );

  test.each(["success", "skipped", "neutral", null])("AC-12 ignores a %s check run", async (conclusion) => {
    const { deps } = githubFixture([checkRun({ conclusion })]);
    expect(await forge.readFailedChecks(gh, "abc123", deps, "/repo")).toEqual([]);
  });

  test("AC-13 keeps the first five failed check runs in reply order", async () => {
    const runs = Array.from({ length: 7 }, (_, index) =>
      checkRun({ id: index + 1, name: `check ${index + 1}`, app: { slug: "other-app" } }),
    );
    const { deps } = githubFixture(runs);
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(forge.MAX_FAILED_CHECKS).toBe(5);
    expect(checks.map((check) => check.name)).toEqual(["check 1", "check 2", "check 3", "check 4", "check 5"]);
  });

  test("AC-14 reads the job log of a GitHub Actions check run", async () => {
    const { deps, calls } = githubFixture([checkRun({ id: 991, app: { slug: "github-actions" } })]);
    await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(calls[1]?.cmd).toEqual(["gh", "run", "view", "--job", "991", "--log-failed", "-R", "github.com/o/r"]);
  });

  test("AC-15 returns the Actions log as a bounded excerpt", async () => {
    const log = `${ESC}[31mboom${ESC}[0m\ntoken ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`;
    const { deps } = githubFixture([checkRun({ id: 991, app: { slug: "github-actions" } })], { "991": log });
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(checks[0]?.excerpt).toBe(forge.ciExcerpt(log));
    expect(checks[0]?.excerpt).toContain("boom");
    expect(checks[0]?.excerpt).not.toContain(ESC);
  });

  test("AC-16 returns the html_url of the check run", async () => {
    const { deps } = githubFixture([
      checkRun({ id: 991, html_url: "https://github.com/o/r/runs/991", app: { slug: "github-actions" } }),
    ]);
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(checks[0]?.url).toBe("https://github.com/o/r/runs/991");
  });

  test("AC-17 makes no log call for a check run from another app", async () => {
    const { deps, calls } = githubFixture([checkRun({ id: 5, app: { slug: "circleci" } })]);
    await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(calls.map((call) => call.cmd)).toEqual([LISTING_ARGV]);
  });

  test("AC-18 builds the excerpt from the check run output", async () => {
    const { deps } = githubFixture([
      checkRun({
        id: 5,
        app: { slug: "circleci" },
        output: { title: "Title", summary: "Summary", text: "Text" },
      }),
    ]);
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(checks[0]?.excerpt).toBe("Title\nSummary\nText");
  });

  test("AC-19 reports no output for a check run without one", async () => {
    const { deps } = githubFixture([
      checkRun({ id: 5, app: { slug: "circleci" }, output: { title: "", summary: "", text: "" } }),
    ]);
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(checks[0]?.excerpt).toBe("(no output)");
  });

  test("reports no output for a check run without an output block", async () => {
    const { deps } = githubFixture([checkRun({ id: 5, app: { slug: "circleci" } })]);
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(checks[0]?.excerpt).toBe("(no output)");
  });

  test("keeps the non-empty parts of a partial output", async () => {
    const { deps } = githubFixture([
      checkRun({ id: 5, app: { slug: "circleci" }, output: { title: "Title", summary: "", text: "Text" } }),
    ]);
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(checks[0]?.excerpt).toBe("Title\nText");
  });

  test("omits the url when the check run has none", async () => {
    const { deps } = githubFixture([checkRun({ id: 5, app: { slug: "circleci" } })]);
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(checks[0]?.url).toBeUndefined();
  });

  test.each([
    ["a failed listing", { exitCode: 1, stdout: "", stderr: "no such commit" }],
    ["an unparseable reply", { exitCode: 0, stdout: "not JSON", stderr: "" }],
    ["a reply without check runs", { exitCode: 0, stdout: "{}", stderr: "" }],
  ])("throws FORGE_CI_READ_FAILED on %s", async (_case, reply) => {
    const deps: ForgeDeps = { run: async () => reply, readText: async () => null };
    const promise = forge.readFailedChecks(gh, "abc123", deps, "/repo");
    await expect(promise).rejects.toBeInstanceOf(NaxError);
    await expect(promise).rejects.toMatchObject({ code: "FORGE_CI_READ_FAILED", context: { stage: "forge" } });
  });
});
