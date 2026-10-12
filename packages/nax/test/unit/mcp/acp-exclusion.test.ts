import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Glob } from "bun";

/**
 * nax#2444 (D1/D3, 2026-10-11): the old invariant — ACP carries no tool
 * surface at all — was deliberately retired; provider tools now ride the
 * loopback host for pre-approval-capable agents, filtered at the hop
 * (`docs/superpowers/specs/2026-10-11-acp-mcp-tool-surface-design.md`). The
 * invariant that REMAINS: the ACP adapter never touches nax's MCP machinery
 * (no `@/mcp` imports, no pool/config types) and never takes the native
 * turn-level `codingTools` channel — its delivery arrives as `providerTools`,
 * policy-filtered before the adapter sees it.
 */
describe("ACP carries no coding-tool channel and no MCP machinery", () => {
  test("no file under src/agents/acp references codingTools or imports nax's mcp modules", async () => {
    const root = resolve(import.meta.dir, "../../../src/agents/acp");
    const offenders: string[] = [];
    for await (const file of new Glob("**/*.ts").scan({ cwd: root, absolute: true })) {
      const text = await Bun.file(file).text();
      if (/codingTools|toolProviders|from "@\/mcp|McpPool|McpConfig\b/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
