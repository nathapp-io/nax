/**
 * #2410 D4 — the native path stamps the session's MCP tool surface into its
 * tool-audit file, and #2444 D4 — the ACP delivery set excludes deny/ask-ruled
 * provider tools (claude pre-approval means delivery time is the only
 * enforcement point on that path).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderTool, ToolProvider } from "@nathapp/nax-agent";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";

let root: string;
let outputDir: string;

beforeEach(() => {
  root = makeTempDir("surface-resolve-");
  outputDir = makeTempDir("surface-out-");
});

afterEach(() => {
  cleanupTempDir(root);
  cleanupTempDir(outputDir);
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

const AUDIT_DIR = () => join(outputDir, "tool-audit", "surface-feature");

const resolveWith = (execution: Record<string, unknown>, providers: readonly ToolProvider[]) =>
  resolveCodingToolSupport({
    declaredTools: ["Read"],
    providers,
    codingToolRoot: root,
    pipelineStage: "run",
    outputDir,
    featureName: "surface-feature",
    config: makeNaxConfig({ execution }),
  });

describe("native tool-surface stamping (D4)", () => {
  test("support carries a native-stamped surface with the advertised provider tools", async () => {
    const support = await resolveWith({ permissionProfile: "unrestricted" }, [fakeProvider("context7", ["query-docs"])]);
    expect(support?.toolSurface?.transport).toBe("native");
    expect(support?.toolSurface?.stage).toBe("run");
    expect(support?.toolSurface?.advertised).toEqual([{ providerId: "context7", names: ["query-docs"] }]);
    expect(support?.toolSurface?.declaredTools).toContain("Read");
    expect(support?.toolSurface?.declaredTools).toContain("context7__query-docs");
  });

  test("the flushed audit file carries the surface", async () => {
    const support = await resolveWith({ permissionProfile: "unrestricted" }, [fakeProvider("context7", ["query-docs"])]);
    await support?.auditSink.flush();
    const files = await readdir(AUDIT_DIR());
    expect(files.length).toBeGreaterThan(0);
    const parsed = JSON.parse(await readFile(join(AUDIT_DIR(), files[0] as string), "utf8"));
    expect(parsed.toolSurface.transport).toBe("native");
    expect(parsed.toolSurface.advertised).toEqual([{ providerId: "context7", names: ["query-docs"] }]);
  });

  test("no providers configured means no surface and no delivery", async () => {
    const support = await resolveWith({ permissionProfile: "unrestricted" }, []);
    expect(support?.toolSurface).toBeUndefined();
    expect(support?.acpDelivery).toBeUndefined();
  });
});

describe("acpDelivery (D4 delivery filter)", () => {
  test("delivers rule-free provider tools with the materialized declaration", async () => {
    const support = await resolveWith({ permissionProfile: "unrestricted" }, [fakeProvider("context7", ["query-docs"])]);
    expect(support?.acpDelivery?.tools.map((tool) => tool.name)).toEqual(["context7__query-docs"]);
    expect(support?.acpDelivery?.declaredTools).toContain("Read");
  });

  test("a deny-ruled tool is withheld from delivery and recorded", async () => {
    const support = await resolveWith(
      { permissionProfile: "unrestricted", permissions: { run: { deny: ["Mcp(context7:query-docs)"] } } },
      [fakeProvider("context7", ["query-docs", "resolve-id"])],
    );
    expect(support?.acpDelivery?.tools.map((tool) => tool.name)).toEqual(["context7__resolve-id"]);
    expect(support?.acpDelivery?.surface.withheld).toEqual([
      { providerId: "context7", name: "query-docs", reason: "denied" },
    ]);
  });

  test("an ask-ruled tool is withheld from delivery", async () => {
    const support = await resolveWith(
      { permissionProfile: "unrestricted", permissions: { run: { ask: ["Mcp(context7)"] } } },
      [fakeProvider("context7", ["query-docs"])],
    );
    expect(support?.acpDelivery?.tools).toEqual([]);
    expect(support?.acpDelivery?.surface.withheld).toEqual([
      { providerId: "context7", name: "query-docs", reason: "ask-ruled" },
    ]);
  });

  test("safe profile (provider scope none) yields no delivery and no surface", async () => {
    const support = await resolveWith(
      { permissionProfile: "safe", permissions: { run: { allow: ["Mcp(context7)"] } } },
      [fakeProvider("context7", ["query-docs"])],
    );
    expect(support?.acpDelivery).toBeUndefined();
    expect(support?.toolSurface).toBeUndefined();
  });
});
