import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { assertDefined, makeNaxConfig } from "@test/helpers";
import { DEFAULT_CONFIG, type NaxConfig, NaxConfigSchema } from "@/config";
import { buildRunDispatchOptions } from "@/operations/call-run-options";
import type { CallContext } from "@/operations/types";
import { buildResourceCatalog } from "@/resources";
import * as runtimeModule from "@/runtime";

const runtimes: runtimeModule.NaxRuntime[] = [];
function runtime(config: NaxConfig) {
  const result = runtimeModule.createRuntime(config, "/repo");
  runtimes.push(result);
  return result;
}
const enabled = () => makeNaxConfig({ resources: { skillsInRun: true } });
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
});

describe("createRuntime skills provider", () => {
  test("AC-1 appends nax-skills when opted in, synchronously", () => {
    expect(runtime(enabled()).toolProviders.map((p) => p.id)).toEqual(["nax-skills"]);
  });

  test("AC-2 skills follow every enabled MCP provider", () => {
    const config = makeNaxConfig({
      resources: { skillsInRun: true },
      mcp: NaxConfigSchema.parse({
        mcp: { servers: { first: { command: "fake" }, second: { command: "fake" } } },
      }).mcp,
    });
    expect(runtime(config).toolProviders.map((p) => p.id)).toEqual(["first", "second", "nax-skills"]);
  });

  test("AC-3 default config has no skills provider", () => {
    expect(runtime(DEFAULT_CONFIG).toolProviders).toEqual([]);
  });

  test("AC-4 legacy config without resources has no skills provider", () => {
    const config = makeNaxConfig();
    delete config.resources;
    expect(runtime(config).toolProviders).toEqual([]);
  });

  test("explicit false preserves MCP-only providers", () => {
    const config = makeNaxConfig({
      resources: { skillsInRun: false },
      mcp: NaxConfigSchema.parse({ mcp: { servers: { memory: { command: "fake" } } } }).mcp,
    });
    expect(runtime(config).toolProviders.map((p) => p.id)).toEqual(["memory"]);
  });

  test("AC-5 catalog loads only on first tools call with run inputs and no plugins", async () => {
    const load = spyOn(runtimeModule._runtimeResourceDeps, "loadResourceCatalog").mockResolvedValue(
      buildResourceCatalog([]),
    );
    try {
      const config = enabled();
      const result = runtime(config);
      expect(load).not.toHaveBeenCalled();
      const skills = result.toolProviders.find((p) => p.id === "nax-skills");
      assertDefined(skills);
      expect(await skills.tools("/repo")).toEqual([]);
      await skills.tools("/repo");
      expect(load).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledWith({
        repoRoot: "/repo",
        config,
        env: process.env,
        naxPluginPackages: [],
      });
    } finally {
      load.mockRestore();
    }
  });
});

describe("buildRunDispatchOptions skills wiring", () => {
  test("AC-6 forwards providers from a real opted-in runtime before call-local providers", () => {
    const config = enabled();
    const result = runtime(config);
    const local = { id: "local", kind: "static" as const, stages: ["*" as const], tools: async () => [] };
    const ctx: CallContext = {
      runtime: result,
      packageView: result.packages.repo(),
      packageDir: "",
      config,
      agentName: "native",
      toolProviders: [local],
    };
    const options = buildRunDispatchOptions(ctx, {
      prompt: "hi",
      effectiveTier: "balanced",
      dispatchModelDef: { provider: "claude", model: "sonnet" },
      config,
      callId: "skills",
      pipelineStage: "run",
      declaredTools: ["Read"],
      keepOpen: false,
    });
    expect(options.providers?.map((p) => p.id)).toEqual(["nax-skills", "local"]);
    expect(options.providers?.[0]).toBe(result.toolProviders[0]);
    expect(result.toolProviders).toHaveLength(1);
  });
});
