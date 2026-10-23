import { describe, expect, test } from "bun:test";
import type { ForgeDeps, ForgeRunResult, PrRef } from "@/forge";
import * as forge from "@/forge";

const gh: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 42 };
const gl: PrRef = { forge: "gitlab", host: "gitlab.com", repo: "g/p", number: 7 };
const ARGV = ["gh", "api", "--allow-escape-sequences", "--hostname", "github.com", "repos/o/r/actions/jobs/991/logs"];
const ok = (stdout: string): ForgeRunResult => ({ exitCode: 0, stdout, stderr: "" });

function fixture(replies: ForgeRunResult[]) {
  const calls: { cmd: string[]; opts: { cwd: string; timeoutMs?: number } }[] = [];
  const deps: ForgeDeps = {
    run: async (cmd, opts) => {
      calls.push({ cmd, opts });
      return replies[calls.length - 1] ?? { exitCode: 1, stdout: "", stderr: "unexpected call" };
    },
    readText: async () => null,
  };
  return { deps, calls };
}

describe("readJobLog", () => {
  test("AC-1 uses the GitHub jobs API and the default timeout", async () => {
    const { deps, calls } = fixture([ok("log")]);
    expect(await forge.readJobLog(gh, "991", deps, "/repo")).toEqual({ ok: true, text: "log" });
    expect(calls).toEqual([{ cmd: ARGV, opts: { cwd: "/repo" } }]);
  });

  test.each([
    ["AC-2 removes a leading BOM", "\uFEFFwhole log", "whole log"],
    ["AC-3 strips ANSI colour", "\u001b[31mred\u001b[0m", "red"],
    [
      "AC-4 redacts the last line of the whole log",
      `${"line\n".repeat(300)}postgres://user:synthetic_password_123@db`,
      `${"line\n".repeat(300)}[REDACTED]db`,
    ],
  ])("%s", async (_name, input, expected) => {
    const { deps } = fixture([ok(input)]);
    expect(await forge.readJobLog(gh, "991", deps, "/repo")).toEqual({ ok: true, text: expected });
  });

  test("AC-5 retries an unsupported flag once without the flag", async () => {
    const { deps, calls } = fixture([
      { exitCode: 1, stdout: "", stderr: "unknown flag: --allow-escape-sequences" },
      ok("fallback"),
    ]);
    expect(await forge.readJobLog(gh, "991", deps, "/repo")).toEqual({ ok: true, text: "fallback" });
    expect(calls.map((call) => call.cmd)).toEqual([ARGV, ARGV.filter((arg) => arg !== "--allow-escape-sequences")]);
  });

  test.each([
    ["AC-6 uses the first stderr line", 1, "boom\nmore", "boom"],
    [
      "AC-7 skips empty lines in timeout stderr",
      124,
      "\n[forge] command killed after 30000ms timeout",
      "[forge] command killed after 30000ms timeout",
    ],
    ["AC-8 defaults empty stderr", 1, "", "unknown"],
    [
      "sanitizes reasons before bounding",
      1,
      "\n\u001b[31mpostgres://user:synthetic_password_123@db\u001b[0m\nmore",
      "[REDACTED]db",
    ],
    ["bounds reasons", 1, "x".repeat(9_000), "x".repeat(forge.CI_EXCERPT_CHARS)],
    ["does not retry unrelated flag errors", 1, "unknown flag: --other", "unknown flag: --other"],
  ] as const)("%s", async (_name, exitCode, stderr, reason) => {
    const { deps, calls } = fixture([{ exitCode, stdout: "", stderr }]);
    expect(await forge.readJobLog(gh, "991", deps, "/repo")).toEqual({ ok: false, reason });
    expect(calls).toHaveLength(1);
  });

  test("stops after one fallback and uses its failure", async () => {
    const unsupported = { exitCode: 1, stdout: "", stderr: "unknown flag: --allow-escape-sequences" };
    const { deps, calls } = fixture([unsupported, unsupported]);
    expect(await forge.readJobLog(gh, "991", deps, "/repo")).toEqual({ ok: false, reason: unsupported.stderr });
    expect(calls).toHaveLength(2);
  });

  test("AC-9 uses the encoded GitLab trace API", async () => {
    const { deps, calls } = fixture([ok("trace")]);
    expect(await forge.readJobLog(gl, "55", deps, "/repo")).toEqual({ ok: true, text: "trace" });
    expect(calls).toEqual([
      { cmd: ["glab", "api", "--hostname", "gitlab.com", "projects/g%2Fp/jobs/55/trace"], opts: { cwd: "/repo" } },
    ]);
  });
});

describe("stripAnsi", () => {
  test("AC-10 exports the ANSI stripper through the forge barrel", () => {
    expect(forge.stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });
});
