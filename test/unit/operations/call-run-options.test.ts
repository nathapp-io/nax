import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory, makeTestRuntime } from "@test/helpers";
import { buildRunDispatchOptions } from "@/operations/call-run-options";
import type { CallContext } from "@/operations/types";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

describe("buildRunDispatchOptions — PR1 fields (single-frame redesign)", () => {
  test("threads projectDir and the story's relative package dir independently of codingToolRoot", () => {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const packageView = runtime.packages.resolve("packages/api");
    const ctx: CallContext = {
      runtime,
      packageView,
      packageDir: "packages/api",
      config,
      agentName: "claude", // required field on CallContext (types.ts:56)
    };

    const result = buildRunDispatchOptions(ctx, {
      prompt: "hi",
      effectiveTier: "balanced",
      dispatchModelDef: { provider: "claude", model: "sonnet" },
      config,
      callId: "call-1",
      pipelineStage: "run",
      declaredTools: ["Read"],
      keepOpen: false,
    });

    expect(result.projectDir).toBe(runtime.projectDir);
    expect(result.codingToolPackageDir).toBe("packages/api");
    // codingToolRoot is the package WORKDIR (absolute) — a different value
    // from codingToolPackageDir (relative) by construction, proving the two
    // are threaded independently rather than one being derived from the
    // other at this call site.
    expect(result.codingToolRoot).not.toBe(result.codingToolPackageDir);
  });

  test("the root package (packageDir '') threads an empty codingToolPackageDir, not undefined", () => {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const packageView = runtime.packages.repo();
    const ctx: CallContext = {
      runtime,
      packageView,
      packageDir: "",
      config,
      agentName: "claude", // required field on CallContext (types.ts:56)
    };

    const result = buildRunDispatchOptions(ctx, {
      prompt: "hi",
      effectiveTier: "balanced",
      dispatchModelDef: { provider: "claude", model: "sonnet" },
      config,
      callId: "call-1",
      pipelineStage: "run",
      declaredTools: ["Read"],
      keepOpen: false,
    });

    expect(result.codingToolPackageDir).toBe("");
  });
});

describe("buildRunDispatchOptions — codingToolWorkdirLabel (single-frame redesign PR2)", () => {
  function build(packageDir: string, story?: ReturnType<typeof makeStory>) {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.resolve(packageDir),
      packageDir,
      config,
      agentName: "claude",
      ...(story !== undefined ? { story } : {}),
    };
    return buildRunDispatchOptions(ctx, {
      prompt: "hi",
      effectiveTier: "balanced",
      dispatchModelDef: { provider: "claude", model: "sonnet" },
      config,
      callId: "call-1",
      pipelineStage: "run",
      declaredTools: ["Read"],
      keepOpen: false,
    });
  }

  test("prefers the story's workdir when the story is in scope", () => {
    expect(build("packages/api", makeStory({ workdir: "packages/api" })).codingToolWorkdirLabel).toBe("packages/api");
    expect(build("", makeStory({})).codingToolWorkdirLabel).toBe(".");
  });

  test("falls back to the package view's dir, stripping a worktree prefix", () => {
    expect(build("packages/api").codingToolWorkdirLabel).toBe("packages/api");
    expect(build(".nax-wt/US-001/packages/api").codingToolWorkdirLabel).toBe("packages/api");
  });

  test("falls back to '.' for the root package when no story is in scope", () => {
    expect(build("").codingToolWorkdirLabel).toBe(".");
  });
});
