import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support";
import type { ProviderTool, ToolProvider } from "@/tools";

let root: string;

beforeEach(() => {
  root = makeTempDir("mcp-scoped-");
});

afterEach(() => {
  cleanupTempDir(root);
});

function fakeProvider(id: string, localNames: readonly string[]): ToolProvider {
  const tools: ProviderTool[] = localNames.map((localName) => ({
    localName,
    description: `${localName} description`,
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ content: "ok" }),
  }));
  return { id, kind: "discovered", stages: ["*"], tools: async () => tools };
}

const resolve = (execution: Record<string, unknown>, providers: readonly ToolProvider[]) =>
  resolveCodingToolSupport({
    declaredTools: ["Read"],
    providers,
    codingToolRoot: root,
    pipelineStage: "run",
    config: makeNaxConfig({ execution }),
  });

describe("MCP under a scoped profile (spec R7 / US-006)", () => {
  test("a scoped stage with Mcp(server) gets exactly that server's tools", async () => {
    const support = await resolve(
      {
        permissionProfile: "scoped",
        permissions: { run: { allow: ["Read", "Mcp(context7)"] } },
      },
      [fakeProvider("context7", ["query-docs", "resolve-id"]), fakeProvider("graph", ["query"])],
    );
    const names = support?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("context7__query-docs");
    expect(names).toContain("context7__resolve-id");
    expect(names).not.toContain("graph__query");
  });

  test("Mcp(server:tool) narrows to one tool", async () => {
    const support = await resolve(
      { permissionProfile: "scoped", permissions: { run: { allow: ["Read", "Mcp(context7:query-docs)"] } } },
      [fakeProvider("context7", ["query-docs", "resolve-id"])],
    );
    const names = support?.tools.map((tool) => tool.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["context7__query-docs"]));
    expect(names).not.toContain("context7__resolve-id");
  });

  test("a scoped stage with NO Mcp rule gets no provider tools", async () => {
    const support = await resolve({ permissionProfile: "scoped", permissions: { run: { allow: ["Read"] } } }, [
      fakeProvider("context7", ["query-docs"]),
    ]);
    expect(support?.tools.map((tool) => tool.name) ?? []).not.toContain("context7__query-docs");
  });

  test("row 10: `safe` advertises no provider tools even with an Mcp rule", async () => {
    const support = await resolve({ permissionProfile: "safe", permissions: { run: { allow: ["Mcp(context7)"] } } }, [
      fakeProvider("context7", ["query-docs"]),
    ]);
    expect(support?.tools.map((tool) => tool.name) ?? []).not.toContain("context7__query-docs");
  });

  test("unrestricted still gets every attached provider (unchanged)", async () => {
    const support = await resolve({ permissionProfile: "unrestricted" }, [fakeProvider("context7", ["query-docs"])]);
    expect(support?.tools.map((tool) => tool.name) ?? []).toContain("context7__query-docs");
  });

  test("a deny rule binds under unrestricted too (spec R10)", async () => {
    const support = await resolve(
      { permissionProfile: "unrestricted", permissions: { run: { deny: ["Mcp(context7:query-docs)"] } } },
      [fakeProvider("context7", ["query-docs", "resolve-id"])],
    );
    const outcome = await support?.runtime.callTool("context7__query-docs", {});
    expect(outcome?.kind).toBe("denied");
  });

  test('"Mcp" never reaches the compiled policy as a tool name', async () => {
    const support = await resolve(
      { permissionProfile: "scoped", permissions: { run: { allow: ["Read", "Mcp(context7)"] } } },
      [fakeProvider("context7", ["query-docs"])],
    );
    const outcome = await support?.runtime.callTool("Mcp", {});
    expect(outcome?.kind).toBe("denied");
  });
});
