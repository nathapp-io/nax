import { describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, PrRef } from "@/forge";
import * as forge from "@/forge";
import { CI_ANNOTATION_CHARS, CI_ANNOTATION_LINES } from "@/forge/job-log";

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
    expect(forge.CI_EXCERPT_LINES).toBe(200);
    const log = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = forge.ciExcerpt(log).split("\n");
    expect(lines).toHaveLength(forge.CI_EXCERPT_LINES);
    expect(lines[0]).toBe("line 301");
    expect(lines[lines.length - 1]).toBe("line 500");
  });

  test("AC-8 keeps the last 8000 characters of one long line", () => {
    expect(forge.CI_EXCERPT_CHARS).toBe(8_000);
    const excerpt = forge.ciExcerpt("x".repeat(20_000));
    expect(excerpt).toHaveLength(forge.CI_EXCERPT_CHARS);
    expect(excerpt).toBe("x".repeat(forge.CI_EXCERPT_CHARS));
  });

  test("AC-9 redacts a token out of the log", () => {
    const excerpt = forge.ciExcerpt("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(excerpt).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });

  test("redacts a credential whose closing delimiter crosses the excerpt boundary", () => {
    // The excerpt keeps the last CI_EXCERPT_CHARS characters, so the cut lands
    // inside the credential: without its closing '@' the URL matcher cannot
    // see the password, and the excerpt would carry it in cleartext.
    const credential = "postgres://alice:synthetic_password_123@db.example";
    const cut = credential.indexOf(":") + 1;
    const log = `${credential}${"x".repeat(forge.CI_EXCERPT_CHARS + cut - credential.length)}`;
    const excerpt = forge.ciExcerpt(log);
    expect(excerpt).not.toContain("synthetic_password_123");
    expect(excerpt).toContain("[REDACTED]");
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
      const jobId = /actions\/jobs\/(\d+)\/logs$/.exec(cmd.at(-1) ?? "")?.[1];
      if (cmd[1] === "api" && jobId !== undefined) return { exitCode: 0, stdout: logs[jobId] ?? "", stderr: "" };
      return { exitCode: 0, stdout: JSON.stringify({ check_runs: runs }), stderr: "" };
    },
    readText: async () => null,
  };
  return { deps, calls };
}

const ANNOTATION_HEADER = "GitHub Actions error annotations:";
const TAIL_SEPARATOR = "\n\nLog tail:\n";

async function actionsExcerpt(log: string): Promise<string> {
  const { deps } = githubFixture([checkRun({ id: 991, app: { slug: "github-actions" } })], { "991": log });
  const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
  expect(checks).toHaveLength(1);
  return checks[0]?.excerpt ?? "";
}

function annotationBlock(excerpt: string): string {
  expect(excerpt).toContain(TAIL_SEPARATOR);
  return excerpt.split(TAIL_SEPARATOR)[0] ?? "";
}

function middleErrorLog(): { log: string; error: string } {
  const error = "2026-10-22T13:21:21.2513942Z ##[error]command (apps/runner) bun run test exited (1)";
  const lines = Array.from({ length: 3_000 }, (_, index) => `line ${index + 1}`);
  lines[1_499] = error;
  return { log: `${lines.join("\n")}\n`, error };
}

function longAnnotations(): string[] {
  return Array.from({ length: 20 }, (_, index) => `##[error]${index}:`.padEnd(300, "x"));
}

function largeTailLog(): string {
  return `##[error]failed\n${`${"x".repeat(200)}\n`.repeat(100)}last log line\n`;
}

describe("readFailedChecks", () => {
  test("US-002 AC-1 leads with timestamped annotations from the middle of the log", async () => {
    const { log, error } = middleErrorLog();
    expect((await actionsExcerpt(log)).startsWith(`${ANNOTATION_HEADER}\n${error}\n`)).toBe(true);
  });

  test("US-002 AC-2 follows annotations with the tail and final non-empty line", async () => {
    const excerpt = await actionsExcerpt(middleErrorLog().log);
    expect(excerpt).toContain(TAIL_SEPARATOR);
    expect(excerpt.split(TAIL_SEPARATOR)[1]?.trimEnd().endsWith("line 3000")).toBe(true);
  });

  test("US-002 AC-3 keeps ciExcerpt for an unannotated Actions log", async () => {
    const log = Array.from({ length: 3_000 }, (_, index) => `line ${index}`).join("\n");
    expect(await actionsExcerpt(log)).toBe(forge.ciExcerpt(log));
  });

  test("US-002 AC-4 keeps only the first 20 annotation lines in order", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `##[error]annotation ${index + 1}`);
    const block = annotationBlock(await actionsExcerpt(lines.join("\n")));
    expect(CI_ANNOTATION_LINES).toBe(20);
    expect(block.split("\n")).toEqual([ANNOTATION_HEADER, ...lines.slice(0, 20)]);
    expect(block).not.toContain(lines[20] ?? "missing annotation");
  });

  test("US-002 AC-5 bounds the annotation block including its header", async () => {
    const block = annotationBlock(await actionsExcerpt(longAnnotations().join("\n")));
    expect(CI_ANNOTATION_CHARS).toBe(2_000);
    expect(block.length).toBeLessThanOrEqual(CI_ANNOTATION_CHARS);
  });

  test("US-002 AC-6 drops overflowing annotation lines whole", async () => {
    const lines = longAnnotations();
    const block = annotationBlock(await actionsExcerpt(lines.join("\n")));
    expect(block.split("\n")).toEqual([ANNOTATION_HEADER, ...lines.slice(0, 6)]);
  });

  test("US-002 AC-7 cuts a single oversized first annotation to the block budget", async () => {
    const line = "##[error]".padEnd(5_000, "x");
    const block = annotationBlock(await actionsExcerpt(line));
    expect(block).toBe(`${ANNOTATION_HEADER}\n${line}`.slice(0, CI_ANNOTATION_CHARS));
  });

  test("US-002 AC-8 budgets annotations, separators and tail together", async () => {
    const excerpt = await actionsExcerpt(largeTailLog());
    expect(excerpt).toContain(TAIL_SEPARATOR);
    expect(excerpt.length).toBeLessThanOrEqual(forge.CI_EXCERPT_CHARS);
  });

  test("US-002 AC-9 preserves the last non-empty line with a trailing newline", async () => {
    const excerpt = await actionsExcerpt(largeTailLog());
    expect(excerpt).toContain(TAIL_SEPARATOR);
    expect(excerpt.trimEnd().split("\n").at(-1)).toBe("last log line");
  });

  test("uses sanitized whole-job text before bounding annotations", async () => {
    const line = `${ESC}[31m##[error] postgres://alice:synthetic_password_123@db${ESC}[0m`;
    const excerpt = await actionsExcerpt(`\uFEFF${line}\nlast line\n`);
    expect(annotationBlock(excerpt)).toContain("##[error] [REDACTED]db");
    expect(excerpt).not.toContain("synthetic_password_123");
    expect(excerpt).not.toContain(ESC);
    expect(excerpt).not.toContain("\uFEFF");
  });

  test("drops the entire suffix once a later annotation exceeds the budget", async () => {
    const excerpt = await actionsExcerpt(`##[error]first\n${"##[error]".padEnd(5_000, "x")}\n##[error]third`);
    expect(annotationBlock(excerpt)).toBe(`${ANNOTATION_HEADER}\n##[error]first`);
  });

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
    expect(calls[1]?.cmd).toEqual([
      "gh",
      "api",
      "--allow-escape-sequences",
      "--hostname",
      "github.com",
      "repos/o/r/actions/jobs/991/logs",
    ]);
    expect(calls.some((call) => call.cmd[1] === "run")).toBe(false);
  });

  test("AC-15 returns the Actions log as a bounded excerpt", async () => {
    const log = `${ESC}[31mboom${ESC}[0m\ntoken ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`;
    const { deps } = githubFixture([checkRun({ id: 991, app: { slug: "github-actions" } })], { "991": log });
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(checks[0]?.excerpt).toBe(forge.ciExcerpt(log));
    expect(checks[0]?.excerpt).toContain("boom");
    expect(checks[0]?.excerpt).not.toContain(ESC);
    expect(checks[0]).not.toHaveProperty("logUnavailable");
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
