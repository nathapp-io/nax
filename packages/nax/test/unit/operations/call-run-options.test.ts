import { afterEach, describe, expect, test } from "bun:test";
import type { AskResolver, CommandShadow, ToolProvider } from "@nathapp/nax-agent";
import type { CommandInterceptor } from "@nathapp/nax-agent/internal";
import { makeNaxConfig, makeStory, makeTestRuntime } from "@test/helpers";
import { buildRunDispatchOptions } from "@/operations/call-run-options";
import type { CallContext } from "@/operations/types";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

describe("buildRunDispatchOptions — call-scoped providers", () => {
  const a: ToolProvider = { id: "a", kind: "static", stages: ["*"], tools: async () => [] };
  const b: ToolProvider = { id: "b", kind: "static", stages: ["*"], tools: async () => [] };

  test.each([
    { runtimeProviders: [a], callProviders: [b], expected: [a, b] },
    { runtimeProviders: [], callProviders: [b], expected: [b] },
    { runtimeProviders: [a], callProviders: undefined, expected: [a] },
    { runtimeProviders: [], callProviders: [], expected: undefined },
    { runtimeProviders: [], callProviders: undefined, expected: undefined },
  ])("merges providers without mutating shared state: %j", ({ runtimeProviders, callProviders, expected }) => {
    const config = makeNaxConfig();
    const runtime = Object.assign(makeTestRuntime({ config, workdir: "/repo" }), {
      toolProviders: Object.freeze(runtimeProviders),
    });
    createdRuntimes.push(runtime);
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "",
      config,
      agentName: "native",
      ...(callProviders !== undefined ? { toolProviders: Object.freeze(callProviders) } : {}),
    };
    const result = buildRunDispatchOptions(ctx, {
      prompt: "hi",
      effectiveTier: "balanced",
      dispatchModelDef: { provider: "claude", model: "sonnet" },
      config,
      callId: "providers",
      pipelineStage: "run",
      declaredTools: ["Read"],
      keepOpen: false,
    });
    expect(result.providers).toEqual(expected === undefined ? undefined : [...expected]);
    expect("providers" in result).toBe(expected !== undefined);
    expect(runtime.toolProviders).toEqual(runtimeProviders);
    expect(ctx.toolProviders).toBe(callProviders);
  });
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

  test("forwards the runtime's runId onto the run options", () => {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const packageView = runtime.packages.resolve("packages/api");
    const ctx: CallContext = {
      runtime,
      packageView,
      packageDir: "packages/api",
      config,
      agentName: "claude",
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

    expect(result.runId).toBe(runtime.runId);
    expect(result.runId).toBeTruthy();
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

describe("buildRunDispatchOptions — askResolver (P2 threading)", () => {
  function build(askResolver?: AskResolver) {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.resolve("packages/api"),
      packageDir: "packages/api",
      config,
      agentName: "claude",
      ...(askResolver !== undefined ? { askResolver } : {}),
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

  test("forwards the caller's askResolver by reference", () => {
    const askResolver: AskResolver = {
      resolve: async () => ({ decision: "deny", decidedBy: "unavailable", latencyMs: 0 }),
    };
    // Identity, not deep equality: the runtime must consult the SAME resolver
    // instance the execution stage built and holds for its run-end teardown.
    expect(build(askResolver).askResolver).toBe(askResolver);
  });

  test("omits askResolver when the caller supplies none", () => {
    expect("askResolver" in build()).toBe(false);
  });
});

describe("buildRunDispatchOptions — commandShadow (P5 threading)", () => {
  function build(commandShadow?: CommandShadow) {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.resolve("packages/api"),
      packageDir: "packages/api",
      config,
      agentName: "claude",
      ...(commandShadow !== undefined ? { commandShadow } : {}),
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

  test("forwards the caller's commandShadow by reference", () => {
    const shadow: CommandShadow = { observe: () => {}, settle: () => {}, drain: async () => {} };
    expect(build(shadow).commandShadow).toBe(shadow);
  });

  test("omits commandShadow when the caller supplies none", () => {
    expect("commandShadow" in build()).toBe(false);
  });
});

describe("buildRunDispatchOptions — the run's command interceptor (S1 spec port 7)", () => {
  const interceptor: CommandInterceptor = { provider: "probe", intercept: async () => ({ kind: "unchanged" }) };

  test("buildRunDispatchOptions carries the runtime's interceptor", () => {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo", commandInterceptor: interceptor });
    createdRuntimes.push(runtime);
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.resolve("packages/api"),
      packageDir: "packages/api",
      config,
      agentName: "claude",
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
    expect(result.commandInterceptor).toBe(interceptor);
  });

  test("a runtime without an interceptor adds no commandInterceptor key", () => {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.resolve("packages/api"),
      packageDir: "packages/api",
      config,
      agentName: "claude",
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
    expect(Object.keys(result)).not.toContain("commandInterceptor");
  });
});

describe("buildRunDispatchOptions — abort signal (finish A, #2462)", () => {
  function ctxFor(): { ctx: CallContext; config: ReturnType<typeof makeNaxConfig> } {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    return {
      config,
      ctx: {
        runtime,
        packageView: runtime.packages.resolve("packages/api"),
        packageDir: "packages/api",
        config,
        agentName: "claude",
      },
    };
  }
  const params = (config: ReturnType<typeof makeNaxConfig>) => ({
    prompt: "hi",
    effectiveTier: "balanced" as const,
    dispatchModelDef: { provider: "claude", model: "sonnet" },
    config,
    callId: "call-1",
    pipelineStage: "run" as const,
    declaredTools: ["Read" as const],
    keepOpen: false,
  });

  test("threads the call's abort signal onto the run options", () => {
    const { ctx, config } = ctxFor();
    const controller = new AbortController();
    const result = buildRunDispatchOptions(ctx, { ...params(config), abortSignal: controller.signal });
    expect(result.abortSignal).toBe(controller.signal);
  });

  test("omits abortSignal when none is given", () => {
    const { ctx, config } = ctxFor();
    expect("abortSignal" in buildRunDispatchOptions(ctx, params(config))).toBe(false);
  });
});

describe("buildRunDispatchOptions — writableOutputPath (nax#2479)", () => {
  function ctxFor(): { ctx: CallContext; config: ReturnType<typeof makeNaxConfig> } {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    return {
      config,
      ctx: { runtime, packageView: runtime.packages.resolve(""), packageDir: "", config, agentName: "native" },
    };
  }
  const params = (config: ReturnType<typeof makeNaxConfig>) => ({
    prompt: "hi",
    effectiveTier: "balanced" as const,
    dispatchModelDef: { provider: "claude", model: "sonnet" },
    config,
    callId: "call-1",
    pipelineStage: "run" as const,
    declaredTools: ["Write" as const],
    keepOpen: false,
  });

  test("forwards a writable output path as the owned-write exemption", () => {
    const { ctx, config } = ctxFor();
    const result = buildRunDispatchOptions(ctx, { ...params(config), writableOutputPath: "/repo/report.md" });
    expect(result.codingToolFileOutput).toBe("/repo/report.md");
  });

  test("a fileOutput path wins when both are given", () => {
    const { ctx, config } = ctxFor();
    const result = buildRunDispatchOptions(ctx, {
      ...params(config),
      fileOutputPath: "/repo/prd.json",
      writableOutputPath: "/repo/report.md",
    });
    expect(result.codingToolFileOutput).toBe("/repo/prd.json");
  });

  test("neither path adds no exemption key", () => {
    const { ctx, config } = ctxFor();
    expect("codingToolFileOutput" in buildRunDispatchOptions(ctx, params(config))).toBe(false);
  });
});
