import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolveProviderTools, type ToolRunContext } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import type { ForgeCheck, ForgeDeps, PrInfo, PrRef } from "@/forge";
import { _forgeToolsDeps, createForgeReadProvider } from "@/forge-tools";
import { markdownFence } from "@/utils/markdown-fence";

const ref: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 7 };
const info: PrInfo = {
  number: 7,
  title: "title ``` hostile",
  body: "PRIVATE DESCRIPTION",
  url: "https://github.com/o/r/pull/7",
  state: "open",
  draft: true,
  author: { login: "writer" },
  baseRef: "main",
  headRef: "fix",
  headSha: "abc123",
  crossRepo: false,
};
const checks: readonly ForgeCheck[] = [
  {
    id: "7",
    name: "test ``` hostile",
    status: "completed",
    conclusion: "failure",
    url: "https://ci/7",
    hasJobLog: true,
  },
  { id: "8", name: "lint", status: "in_progress", hasJobLog: false },
  { id: "9", name: "build", status: "queued", hasJobLog: true },
];
const deps: ForgeDeps = {
  run: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  readText: async () => null,
};
const ctx: ToolRunContext = { root: "/other-worktree", resolvedPaths: [], maxBytes: 2_000, maxFileBytes: 2_000 };
const original = { ..._forgeToolsDeps };
const binding = () => ({ resolveRef: mock(async () => ref), deps, cwd: "/bound-repo" });
async function tool(name: string) {
  const tools = await createForgeReadProvider(binding()).tools(ctx.root);
  const found = tools.find((entry) => entry.localName === name);
  assertDefined(found);
  return found;
}
beforeEach(() => {
  _forgeToolsDeps.readPrInfo = mock(async () => info);
  _forgeToolsDeps.listHeadChecks = mock(async () => checks);
});
afterEach(() => Object.assign(_forgeToolsDeps, original));

describe("PR read handlers", () => {
  test("AC-1 advertises namespaced pr and checks", async () => {
    const resolved = await resolveProviderTools([createForgeReadProvider(binding())], "run", ctx.root);
    expect(resolved.failures).toEqual([]);
    expect(resolved.tools.map((entry) => entry.name)).toContain("nax-forge__pr");
    expect(resolved.tools.map((entry) => entry.name)).toContain("nax-forge__checks");
  });
  test("AC-2 reads the resolved reference with bound deps and cwd", async () => {
    await (await tool("pr")).run({}, ctx);
    expect(_forgeToolsDeps.readPrInfo).toHaveBeenCalledWith(ref, deps, "/bound-repo");
  });
  test("AC-3 returns all metadata without the description body", async () => {
    const result = await (await tool("pr")).run({}, ctx);
    expect(result.isError).not.toBe(true);
    for (const value of ["number: 7", "state: open", "draft: true", "base: main", "head: fix", "sha: abc123", info.url])
      expect(result.content).toContain(value);
    expect(result.content).not.toContain(info.body);
  });
  test("AC-4 encloses hostile title in one safe markdown fence", async () => {
    const result = await (await tool("pr")).run({}, ctx);
    const payload = result.content.split("\n").slice(2, -1).join("\n");
    expect(payload).toContain(`title: ${info.title}`);
    expect(result.content).toBe(`Bound PR\n${markdownFence(payload)}`);
  });
  test("AC-6 fences every check id, name and status", async () => {
    const result = await (await tool("checks")).run({}, ctx);
    expect(result.isError).not.toBe(true);
    const payload = result.content.split("\n").slice(2, -1).join("\n");
    const lines = payload.split("\n");
    expect(lines).toHaveLength(checks.length);
    for (const [index, check] of checks.entries()) {
      for (const value of [check.id, check.name, check.status]) expect(lines[index]).toContain(value);
    }
    expect(result.content).toBe(`Head checks\n${markdownFence(payload)}`);
  });
  test("AC-7 includes completed conclusion on the check line", async () => {
    const result = await (await tool("checks")).run({}, ctx);
    expect(result.content.split("\n").find((line) => line.includes(checks[0].name))).toContain("failure");
  });
  test("AC-8 includes optional URL on the check line", async () => {
    const result = await (await tool("checks")).run({}, ctx);
    expect(result.content.split("\n").find((line) => line.includes(checks[0].name))).toContain("https://ci/7");
  });
  test.each([
    ["AC-9", "\nboom\nmore", "boom"],
    ["AC-10", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "[REDACTED]"],
  ])("%s returns first non-empty redacted error line", async (_ac, message, expected) => {
    _forgeToolsDeps.listHeadChecks = mock(async () => {
      throw new Error(message);
    });
    const result = await (await tool("checks")).run({}, ctx);
    expect(result).toEqual({ isError: true, content: expected });
    expect(result.content).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });
  test.each(["pr", "checks"])("%s rejects overrides before resolving or reading", async (name) => {
    const bound = binding();
    const provider = createForgeReadProvider(bound);
    const handler = (await provider.tools(ctx.root)).find((entry) => entry.localName === name);
    assertDefined(handler);
    expect((await handler.run({ headSha: "other" }, ctx)).isError).toBe(true);
    expect(bound.resolveRef).not.toHaveBeenCalled();
    expect(_forgeToolsDeps.readPrInfo).not.toHaveBeenCalled();
    expect(_forgeToolsDeps.listHeadChecks).not.toHaveBeenCalled();
  });
  test("checks fits whole entries from the start within the output budget", async () => {
    _forgeToolsDeps.listHeadChecks = mock(async () =>
      Array.from({ length: 30 }, (_, i) => ({ ...checks[1], id: String(i), name: `check-${i}` })),
    );
    const result = await (await tool("checks")).run({}, { ...ctx, maxBytes: 160 });
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(160);
    expect(result.content).toContain("check-0");
    expect(result.content).not.toContain("check-29");
    expect(result.content).toMatch(/\n```\n\[truncated: \d+ entries not shown\]$/);
  });
});
