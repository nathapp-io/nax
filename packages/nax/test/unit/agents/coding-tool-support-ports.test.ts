/**
 * Production wiring of the ports nax supplies to the coding tools (S1 spec
 * section 8: "a test that nax's production wiring supplies it"). Each port is
 * driven through `resolveCodingToolSupport`, the entry both dispatch hops use,
 * so a port that is declared but never threaded fails here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeNaxConfig, makeTempDir, withDepsRestore } from "@test/helpers";
import { _codingToolSupportDeps, resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";
import { runQualityCommand } from "@/quality";
import type { DeclaredCommandRequest } from "@/tools";

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
