/**
 * Production wiring of the ports nax supplies to the coding tools (S1 spec
 * section 8: "a test that nax's production wiring supplies it"). Each port is
 * driven through `resolveCodingToolSupport`, the entry both dispatch hops use,
 * so a port that is declared but never threaded fails here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type DeclaredCommandRequest, gitExcludePathspecsOf, gitIgnorePatternsOf } from "@nathapp/nax-agent";
import type { CommandInterceptor } from "@nathapp/nax-agent/internal";
import { _launcherDeps } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeNaxConfig, makeSpawn, makeTempDir, withDepsRestore } from "@test/helpers";
import { _codingToolSupportDeps, resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";
import { runQualityCommand } from "@/quality";
import { _gitDeps } from "@/utils/git";

let root: string;
beforeEach(() => {
  root = makeTempDir("nax-cts-ports-");
});
afterEach(() => cleanupTempDir(root));

describe("port 7: declared-command runner", () => {
  withDepsRestore(_codingToolSupportDeps, ["runDeclaredCommand"]);

  test("defaults to nax's quality runner", () => {
    expect(_codingToolSupportDeps.runDeclaredCommand).toBe(runQualityCommand);
  });

  test("reaches the RunCommand tool through the production entry", async () => {
    const seen: DeclaredCommandRequest[] = [];
    _codingToolSupportDeps.runDeclaredCommand = async (request) => {
      seen.push(request);
      return { success: true, exitCode: 0, output: "" };
    };
    const support = await resolveCodingToolSupport({
      declaredTools: ["RunCommand"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ quality: { commands: { lint: "bun lint" } } }),
    });
    await support?.runtime.callTool("RunCommand", { command: "lint" });
    expect(seen.map((request) => request.commandName)).toEqual(["lint"]);
  });
});

/** Records which site consulted it, and declines, so the original command runs. */
function recordingInterceptor(sites: string[]): CommandInterceptor {
  return {
    provider: "probe",
    intercept: async (request) => {
      sites.push(request.site);
      return { kind: "declined", reason: "probe" };
    },
    interceptShell: async (request) => {
      sites.push(request.site);
      return { kind: "declined", reason: "probe" };
    },
  };
}

describe("port 7: command interceptor", () => {
  withDepsRestore(_gitDeps, ["spawn"]);
  withDepsRestore(_launcherDeps, ["runArgv"]);

  test("one interceptor reaches both the Git and the Bash tool contexts", async () => {
    _gitDeps.spawn = makeSpawn(() => "out").spawn;
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    const sites: string[] = [];
    // `permissions.run.allow` is in the zod schema but not the narrow runtime
    // alias, so the block is widened here, as coding-tool-support-bash-approval.test.ts does.
    const execution: Record<string, unknown> = {
      permissions: { run: { allow: ["Bash(echo *)"] } },
      sandbox: { enabled: false },
    };
    const support = await resolveCodingToolSupport({
      declaredTools: ["Git", "Bash"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution }),
      commandInterceptor: recordingInterceptor(sites),
    });
    await support?.runtime.callTool("Git", { subcommand: "log" });
    await support?.runtime.callTool("Bash", { command: "echo hi" });
    expect(sites).toEqual(["git", "bash"]);
  });

  test("no interceptor in the options means neither site is intercepted", async () => {
    _gitDeps.spawn = makeSpawn(() => "out").spawn;
    const support = await resolveCodingToolSupport({
      declaredTools: ["Git"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution: { sandbox: { enabled: false } } }),
    });
    const outcome = await support?.runtime.callTool("Git", { subcommand: "log" });
    expect(outcome?.kind).toBe("ok");
  });
});

describe("port 6: protected paths", () => {
  withDepsRestore(_gitDeps, ["spawn"]);

  test("the Git tool's default view still excludes .nax through the production entry", async () => {
    const spawned: string[][] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      spawned.push([...cmd]);
      return "out";
    }).spawn;
    const support = await resolveCodingToolSupport({
      declaredTools: ["Git"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution: { sandbox: { enabled: false } } }),
    });
    await support?.runtime.callTool("Git", { subcommand: "status" });
    expect(spawned[0]).toContain(":(exclude).nax");
    expect(spawned[0]).toContain(":(glob,exclude)**/.nax/**");
  });

  test("a tool context without a policy excludes and filters nothing extra", () => {
    expect(gitExcludePathspecsOf({})).toEqual([]);
    expect(gitIgnorePatternsOf({})).toEqual([]);
  });
});
