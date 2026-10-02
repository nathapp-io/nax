import { beforeEach, describe, expect, test } from "bun:test";
import type { CommandInterceptor } from "@nathapp/nax-agent/internal";
import { gitTool } from "@nathapp/nax-agent/internal";
import { makeSpawn, withDepsRestore } from "@test/helpers";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";
import { _gitDeps } from "@/utils/git";

let interceptor: CommandInterceptor | undefined;

describe("Git tool interception — rtk postProcess (stays in nax: the real rtk interceptor is nax's)", () => {
  withDepsRestore(_gitDeps, ["spawn"]);
  beforeEach(() => {
    interceptor = undefined;
  });

  const ctx = () => ({
    root: "/repo",
    resolvedPaths: [],
    maxBytes: 4096,
    maxFileBytes: 1024,
    ...(interceptor !== undefined ? { interceptor } : {}),
  });

  test("a hint is stripped from output that also needs trimming", async () => {
    // The call site runs postProcess BEFORE trimEnd, so it must strip a hint
    // even when the hint is not the final characters — the trailing whitespace
    // after it is exactly what trimEnd would otherwise remove.
    _gitDeps.spawn = makeSpawn(() => "body\n[full diff: rtk git diff --no-compact]\n   ").spawn;
    interceptor = createRtkInterceptor({
      enabled: true,
      verbs: ["log"],
      _deps: { which: () => "/usr/bin/rtk", version: () => "0.45.0", record: () => {} },
    });

    const result = await gitTool.run({ subcommand: "log" }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("body");
  });
});
