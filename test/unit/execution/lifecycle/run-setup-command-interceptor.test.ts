import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeSpawn, withDepsRestore } from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { RtkDeps } from "@/execution/interceptors/rtk";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";
import { _gitToolDeps, gitTool } from "@/tools/git";
import { _gitDeps } from "@/utils/git";

const ctx = () => ({ root: "/repo", resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 });

/** The exact install setupRun performs (run-setup.ts), with `_deps` injected so no real rtk binary is consulted. */
function installFromConfig(config: NaxConfig, deps: Partial<RtkDeps>): void {
  const ci = config.execution.commandInterceptor;
  _gitToolDeps.interceptor = createRtkInterceptor({
    enabled: ci.enabled,
    verbs: ci.git.verbs,
    _deps: deps,
  });
}

describe("setupRun → command interceptor composition (config → provider → Git tool)", () => {
  withDepsRestore(_gitToolDeps, ["interceptor"]);
  withDepsRestore(_gitDeps, ["spawn"]);

  test("with enabled: false no rewrite occurs", async () => {
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push([...cmd]);
      return "out";
    }).spawn;

    installFromConfig(makeNaxConfig({ execution: { commandInterceptor: { enabled: false } } }), {
      which: () => "/usr/bin/rtk",
      version: () => "0.45.0",
      record: () => {},
    });

    const result = await gitTool.run({ subcommand: "log" }, ctx());

    expect(result.isError).toBeFalsy();
    expect(calls[0]?.[0]).toBe("git");
    expect(result.audit).toBeUndefined();
  });

  test("with enabled: true and rtk absent every command still succeeds unchanged", async () => {
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push([...cmd]);
      return "out";
    }).spawn;

    installFromConfig(makeNaxConfig({ execution: { commandInterceptor: { enabled: true } } }), {
      which: () => null,
      version: () => null,
      record: () => {},
    });

    // The provider really is installed, and the configured verbs match — the
    // interceptor declines only because the preflight probe found no binary.
    expect(_gitToolDeps.interceptor?.provider).toBe("rtk");
    const outcome = await _gitToolDeps.interceptor?.intercept({
      kind: "argv",
      argv: ["git", "diff"],
      cwd: "/repo",
      site: "git",
    });
    expect(outcome?.kind).toBe("declined");

    const result = await gitTool.run({ subcommand: "diff" }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("out");
    expect(calls[0]?.[0]).toBe("git");
    expect(result.audit).toBeUndefined();
  });
});
