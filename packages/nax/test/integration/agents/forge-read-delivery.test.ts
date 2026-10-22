import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ToolProvider } from "@nathapp/nax-agent";
import { cleanupTempDir, makeNaxConfig, makeTempDir, makeTestRuntime } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";
import { buildRunDispatchOptions } from "@/operations/call-run-options";
import type { NaxRuntime } from "@/runtime";

const runtimes: NaxRuntime[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
  await Promise.all(dirs.map(cleanupTempDir));
  runtimes.length = 0;
  dirs.length = 0;
});

async function resolve(permissionProfile: "unrestricted" | "safe") {
  const root = makeTempDir("forge-delivery-");
  dirs.push(root);
  const config = makeNaxConfig({ execution: { permissionProfile, iterationDelayMs: 0 } });
  const tools = mock(async () => [
    {
      localName: "pr",
      description: "Read the bound PR",
      inputSchema: { type: "object", properties: {} },
      run: async () => ({ content: "PR fixture" }),
    },
  ]);
  const provider: ToolProvider = { id: "nax-forge", kind: "static", stages: ["*"], tools };
  const runtime = makeTestRuntime({ config, workdir: root });
  runtimes.push(runtime);
  const options = buildRunDispatchOptions(
    {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "",
      config,
      agentName: "claude",
      toolProviders: [provider],
    },
    {
      prompt: "repair",
      effectiveTier: "balanced",
      dispatchModelDef: { provider: "claude", model: "sonnet" },
      config,
      callId: "forge-delivery",
      pipelineStage: "run",
      declaredTools: ["Read"],
      keepOpen: false,
    },
  );
  expect(options.providers).toEqual([provider]);
  return { support: await resolveCodingToolSupport(options), tools };
}

describe("call-scoped forge provider delivery", () => {
  test("unrestricted advertises the forge PR tool through native support", async () => {
    const { support, tools } = await resolve("unrestricted");
    expect(tools).toHaveBeenCalledTimes(1);
    expect(support?.toolSurface?.declaredTools).toContain("nax-forge__pr");
    expect(support?.toolSurface?.advertised).toEqual([{ providerId: "nax-forge", names: ["pr"] }]);
  });

  test("unrestricted delivers the forge PR tool for ACP Claude pre-approval", async () => {
    const { support } = await resolve("unrestricted");
    expect(support?.acpDelivery?.tools.map((tool) => tool.name)).toEqual(["nax-forge__pr"]);
  });

  test("safe advertises no forge tools and never resolves the provider", async () => {
    const { support, tools } = await resolve("safe");
    expect(support).toBeDefined();
    expect(support?.toolSurface?.declaredTools.some((name) => name.startsWith("nax-forge__"))).toBe(false);
    expect(support?.acpDelivery?.tools ?? []).toEqual([]);
    expect(tools).not.toHaveBeenCalled();
  });
});
