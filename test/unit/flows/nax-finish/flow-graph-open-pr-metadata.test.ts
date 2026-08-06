/**
 * `open_pr` node finish-metadata assembly: title/body sourced from
 * loadFinishPrContext/buildFinishTitle/buildFinishBody, with fallback to the
 * fixed `nax-finish: <feature>` strings on any throw.
 *
 * Split out of `flow-graph.test.ts` (800-line test cap).
 */
import { afterEach, describe, expect, test } from "bun:test";
import flow, { _openPrDeps } from "@flows/nax-finish/nax-finish.flow";
import { _gitDeps } from "@flows/nax-finish/steps/git";
import { _prDeps } from "@flows/nax-finish/steps/pr";
import type { FinishPrContext } from "@flows/nax-finish/steps/pr-body";
import { _resultDeps } from "@flows/nax-finish/steps/result";
import type { FlowNodeContext } from "acpx/flows";
import { makeFlowCtx } from "@test/helpers";

const INPUT = { feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false };

// Every field is non-optional on FinishPrContext — a stub must build a real
// (if empty) context rather than `{}`, since the builders no longer defend
// against missing fields.
const minimalCtx = (): FinishPrContext => ({
  feature: INPUT.feature,
  stories: [],
  outOfScope: [],
  gatesRan: [],
  rounds: [],
  run: {},
});

const ctxOf = (over: { outputs?: Record<string, unknown> }): FlowNodeContext =>
  makeFlowCtx({ input: INPUT, ...over });

type NodeRun<T> = { run: (ctx: FlowNodeContext) => Promise<T> | T };
const nodeRun = <T>(id: string) => flow.nodes[id] as unknown as NodeRun<T>;

describe("open_pr node — finish metadata (US-005 AC8-AC12)", () => {
  const originalPrRun = _prDeps.run;
  const originalGitRun = _gitDeps.run;
  const originalWriteText = _resultDeps.writeText;
  const originalLoadFinishPrContext = _openPrDeps.loadFinishPrContext;
  const originalBuildFinishTitle = _openPrDeps.buildFinishTitle;
  const originalBuildFinishBody = _openPrDeps.buildFinishBody;
  afterEach(() => {
    _prDeps.run = originalPrRun;
    _gitDeps.run = originalGitRun;
    _resultDeps.writeText = originalWriteText;
    _openPrDeps.loadFinishPrContext = originalLoadFinishPrContext;
    _openPrDeps.buildFinishTitle = originalBuildFinishTitle;
    _openPrDeps.buildFinishBody = originalBuildFinishBody;
  });

  const mockCleanCommit = () => {
    _gitDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    _resultDeps.writeText = async () => {};
  };

  const captureCreateTitleBody = (): { title(): string; body(): string } => {
    let title = "";
    let body = "";
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return { exitCode: 0, stdout: "git@github.com:o/r", stderr: "" };
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pr found" };
      if (cmd.includes("create")) {
        const t = cmd.indexOf("--title");
        const b = cmd.indexOf("--body");
        title = t >= 0 ? cmd[t + 1] : "";
        body = b >= 0 ? cmd[b + 1] : "";
        return { exitCode: 0, stdout: "https://gh/pr/1", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return { title: () => title, body: () => body };
  };

  test("US-005 AC8 passes buildFinishTitle's stubbed return as the PR title", async () => {
    mockCleanCommit();
    const captured = captureCreateTitleBody();
    _openPrDeps.loadFinishPrContext = async () => minimalCtx();
    _openPrDeps.buildFinishTitle = () => "STUB-TITLE";

    await nodeRun("open_pr").run(ctxOf({ outputs: { load_ctx: { route: "proceed", base: "origin/main" } } }));

    expect(captured.title()).toBe("STUB-TITLE");
  });

  test("US-005 AC9 passes buildFinishBody's stubbed return as the PR body", async () => {
    mockCleanCommit();
    const captured = captureCreateTitleBody();
    _openPrDeps.loadFinishPrContext = async () => minimalCtx();
    _openPrDeps.buildFinishBody = () => "STUB-BODY";

    await nodeRun("open_pr").run(ctxOf({ outputs: { load_ctx: { route: "proceed", base: "origin/main" } } }));

    expect(captured.body()).toBe("STUB-BODY");
  });

  test("US-005 AC10 does not invoke loadFinishPrContext when load_ctx.route is nothing-to-finish", async () => {
    let calls = 0;
    _openPrDeps.loadFinishPrContext = async () => {
      calls++;
      return minimalCtx();
    };
    _resultDeps.writeText = async () => {};

    await nodeRun("open_pr").run(ctxOf({ outputs: { load_ctx: { route: "nothing-to-finish" } } }));

    expect(calls).toBe(0);
  });

  test("US-005 AC11 falls back to `nax-finish: <feature>` title and body when loadFinishPrContext throws", async () => {
    mockCleanCommit();
    const captured = captureCreateTitleBody();
    _openPrDeps.loadFinishPrContext = async () => {
      throw new Error("artifact read failed");
    };

    await nodeRun("open_pr").run(ctxOf({ outputs: { load_ctx: { route: "proceed", base: "origin/main" } } }));

    expect(captured.title()).toBe(`nax-finish: ${INPUT.feature}`);
    expect(captured.body()).toBe(`Automated finish of \`${INPUT.feature}\`.`);
  });

  test("US-005 AC12 falls back to the default title and body when buildFinishTitle throws", async () => {
    mockCleanCommit();
    const captured = captureCreateTitleBody();
    _openPrDeps.loadFinishPrContext = async () => minimalCtx();
    _openPrDeps.buildFinishTitle = () => {
      throw new Error("builder blew up");
    };

    await nodeRun("open_pr").run(ctxOf({ outputs: { load_ctx: { route: "proceed", base: "origin/main" } } }));

    expect(captured.title()).toBe(`nax-finish: ${INPUT.feature}`);
    expect(captured.body()).toBe(`Automated finish of \`${INPUT.feature}\`.`);
  });

  test("US-005 AC12 falls back to the default title and body when buildFinishBody throws", async () => {
    mockCleanCommit();
    const captured = captureCreateTitleBody();
    _openPrDeps.loadFinishPrContext = async () => minimalCtx();
    _openPrDeps.buildFinishBody = () => {
      throw new Error("builder blew up");
    };

    await nodeRun("open_pr").run(ctxOf({ outputs: { load_ctx: { route: "proceed", base: "origin/main" } } }));

    expect(captured.title()).toBe(`nax-finish: ${INPUT.feature}`);
    expect(captured.body()).toBe(`Automated finish of \`${INPUT.feature}\`.`);
  });

  test("routes to narrate once the PR is open, so the narrative runs after it", async () => {
    mockCleanCommit();
    captureCreateTitleBody();
    _openPrDeps.loadFinishPrContext = async () => minimalCtx();

    const out = await nodeRun<{ route: string }>("open_pr").run(
      ctxOf({ outputs: { load_ctx: { route: "proceed", base: "origin/main", specPath: "/s.md" } } }),
    );

    expect(out.route).toBe("narrate");
  });

  test("routes to done for a nothing-to-finish run — there is no diff to narrate", async () => {
    _resultDeps.writeText = async () => {};

    const out = await nodeRun<{ route: string }>("open_pr").run(
      ctxOf({ outputs: { load_ctx: { route: "nothing-to-finish" } } }),
    );

    expect(out.route).toBe("done");
  });

  test("hands one detected forge to both the body builder and the PR opener", async () => {
    // Detecting separately in each would let the body and the create command
    // disagree about the forge.
    mockCleanCommit();
    captureCreateTitleBody();
    let forgeSeenByBody: string | undefined;
    _openPrDeps.loadFinishPrContext = async (_input, args) => {
      forgeSeenByBody = (args as { forge?: string }).forge;
      return minimalCtx();
    };

    await nodeRun("open_pr").run(
      ctxOf({ outputs: { load_ctx: { route: "proceed", base: "origin/main" } } }),
    );

    expect(forgeSeenByBody).toBe("github");
  });

  test("threads load_ctx.specPath into the body builder for the mechanical fallback", async () => {
    mockCleanCommit();
    captureCreateTitleBody();
    let specPathSeen: string | undefined;
    _openPrDeps.loadFinishPrContext = async (_input, args) => {
      specPathSeen = (args as { specPath?: string }).specPath;
      return minimalCtx();
    };

    await nodeRun("open_pr").run(
      ctxOf({ outputs: { load_ctx: { route: "proceed", base: "origin/main", specPath: "/spec.md" } } }),
    );

    expect(specPathSeen).toBe("/spec.md");
  });
});
