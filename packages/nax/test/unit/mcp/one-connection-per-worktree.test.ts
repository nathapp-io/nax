/**
 * Single-frame redesign PR2 (root move) regression pin.
 *
 * Task 1 collapsed the agent root onto `storyExecRoot(ctx.packageView)`, so two
 * package stories in the SAME repo now resolve the SAME workdir and must share
 * ONE MCP connection. This test drives the REAL production chain — runtime's
 * MCP providers -> `buildRunDispatchOptions` (which derives `codingToolRoot`) ->
 * `resolveCodingToolSupport` -> `resolveProviderTools` -> provider.tools(workdir)
 * -> `pool.listTools(serverId, workdir)` — and counts actual subprocess connects.
 *
 * The pool itself performs NO normalization: it keys connections by the literal
 * `workdir` string (src/mcp/pool.ts:66). Calling `pool.listTools` directly with
 * two raw package dirs would therefore create two connections BEFORE and AFTER
 * Task 1, proving nothing. The collapse happens UPSTREAM in
 * `buildRunDispatchOptions`, so this test goes through it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeMockRuntime, makeNaxConfig } from "@test/helpers";
import { _codingToolSupportDeps, resolveCodingToolSupport } from "@/agents/coding-tool-support";
import type { McpServerConfig } from "@/config";
import { _mcpClientDeps } from "@/mcp/client";
import { buildRunDispatchOptions } from "@/operations/call-run-options";
import type { CallContext } from "@/operations/types";

const REPO_ROOT = "/repo";

interface Transport {
  readonly cwd: string;
  readonly pid: number;
}

/** Counts connects at the same seam pool.test.ts uses (src/mcp/client.ts:20). */
function fakeMcpClient(): { transports: Transport[] } {
  const transports: Transport[] = [];
  let nextPid = 100;
  Object.assign(_mcpClientDeps, {
    createTransport: (params: { cwd: string }) => {
      const pid = nextPid++;
      transports.push({ cwd: params.cwd, pid });
      return { pid, close: async () => {} };
    },
    createClient: () => ({
      connect: async () => {},
      listTools: async () => ({
        tools: [{ name: "search_graph", description: "search", inputSchema: { type: "object" } }],
      }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    }),
  });
  return { transports };
}

const originalClientDeps = { ..._mcpClientDeps };
const originalSupportDeps = { ..._codingToolSupportDeps };
afterEach(() => {
  Object.assign(_mcpClientDeps, originalClientDeps);
  Object.assign(_codingToolSupportDeps, originalSupportDeps);
});

const servers: Record<string, McpServerConfig> = {
  memory: { command: "fake", args: [], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true },
};

const config = makeNaxConfig({ mcp: { servers } });

function dispatchOptionsFor(runtime: CallContext["runtime"], view: CallContext["packageView"]) {
  const ctx: CallContext = {
    runtime,
    packageView: view,
    packageDir: view.packageDir,
    agentName: "claude",
    storyId: "US-001",
  };
  return buildRunDispatchOptions(ctx, {
    prompt: "do the thing",
    effectiveTier: "balanced",
    dispatchModelDef: { provider: "anthropic", model: "claude-3-5-sonnet" },
    config,
    callId: "call-1",
    pipelineStage: "run",
    declaredTools: ["Read"],
    keepOpen: false,
  });
}

describe("MCP pool: one connection per worktree", () => {
  test("two package stories over one repoRoot share ONE MCP connection", async () => {
    const sdk = fakeMcpClient();
    // Avoid real disk I/O on the per-package config lookup; the root derivation
    // under test does not depend on this value.
    Object.assign(_codingToolSupportDeps, { loadConfigForPackage: async () => config });

    const runtime = makeMockRuntime({ config, workdir: REPO_ROOT });
    const viewA = runtime.packages.resolve("packages/api");
    const viewB = runtime.packages.resolve("packages/web");

    // Two DISTINCT relative package dirs over the SAME repo root.
    expect(viewA.packageDir).toBe("packages/api");
    expect(viewB.packageDir).toBe("packages/web");
    expect(viewA.packageDir).not.toBe(viewB.packageDir);
    expect(viewA.repoRoot).toBe(REPO_ROOT);
    expect(viewB.repoRoot).toBe(REPO_ROOT);

    const optsA = dispatchOptionsFor(runtime, viewA);
    const optsB = dispatchOptionsFor(runtime, viewB);

    // Production derivation post-Task-1: storyExecRoot collapses both views to
    // the repo root (neither carries a `.nax-wt/<id>/` prefix).
    expect(optsA.codingToolRoot).toBe(REPO_ROOT);
    expect(optsB.codingToolRoot).toBe(REPO_ROOT);
    expect(optsA.codingToolRoot).toBe(optsB.codingToolRoot);

    await resolveCodingToolSupport(optsA);
    await resolveCodingToolSupport(optsB);

    expect(sdk.transports.length).toBe(1);
    expect(sdk.transports.map((t) => t.cwd)).toEqual([REPO_ROOT]);
  });
});
