import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resolveProviderTools, type ToolRunContext } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import type { ForgeDeps, PrComment, PrRef } from "@/forge";
import { _forgeToolsDeps, createForgeReadProvider } from "@/forge-tools";
import { FORGE_COMMENT_CHARS, FORGE_MAX_COMMENTS } from "@/forge-tools/constants";
import { initLogger, resetLogger } from "@/logger";
import { markdownFence } from "@/utils/markdown-fence";

const ref: PrRef = { forge: "gitlab", host: "gitlab.com", repo: "g/p", number: 7 };
const deps: ForgeDeps = {
  run: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  readText: async () => null,
};
const ctx: ToolRunContext = { root: "/other", resolvedPaths: [], maxBytes: 200_000, maxFileBytes: 200_000 };
const original = { ..._forgeToolsDeps };
const binding = { resolveRef: async () => ref, deps, cwd: "/bound" };
function comment(index = 0, overrides: Partial<PrComment> = {}): PrComment {
  return {
    id: String(index),
    kind: "comment",
    author: "writer",
    authorId: 42,
    body: `body-${index}!`,
    createdAt: new Date(index * 1000).toISOString(),
    ...overrides,
  };
}
async function tool(provider = createForgeReadProvider(binding)) {
  const found = (await provider.tools(ctx.root)).find((entry) => entry.localName === "comments");
  assertDefined(found);
  return found;
}
beforeEach(() => {
  _forgeToolsDeps.listPrComments = mock(async () => [comment()]);
  _forgeToolsDeps.hasWriteAccess = mock(async (_ref, who) => who.login !== "outsider");
});
afterEach(() => {
  Object.assign(_forgeToolsDeps, original);
  resetLogger();
});

describe("comments tool", () => {
  test("AC-1 advertises namespaced comments", async () => {
    const resolved = await resolveProviderTools([createForgeReadProvider(binding)], "run", ctx.root);
    expect(resolved.tools.map((entry) => entry.name)).toContain("nax-forge__comments");
  });
  test("AC-3 shows writer comments and review bodies with authors", async () => {
    _forgeToolsDeps.listPrComments = mock(async () => [comment(), comment(1, { kind: "review", author: "reviewer" })]);
    const result = await (await tool()).run({}, ctx);
    expect(result.content).toContain("writer:\nbody-0!");
    expect(result.content).toContain("reviewer:\nbody-1!");
    expect(result.isError).not.toBe(true);
  });
  test("AC-4 omits nonwriters and counts withheld outside the fence", async () => {
    _forgeToolsDeps.listPrComments = mock(async () => [comment(), comment(1, { author: "outsider", body: "SECRET" })]);
    const result = await (await tool()).run({}, ctx);
    expect(result.content).toContain("body-0!");
    expect(result.content).not.toContain("outsider");
    expect(result.content).not.toContain("SECRET");
    expect(result.content).toEndWith("```\nwithheld 1 comment(s) from authors without write access");
  });
  test("AC-5/6 selects latest 50 by timestamp and displays oldest first", async () => {
    _forgeToolsDeps.listPrComments = mock(async () => Array.from({ length: 70 }, (_, i) => comment(i)).reverse());
    const result = await (await tool()).run({}, ctx);
    const shown = Array.from(result.content.matchAll(/body-(\d+)!/g), (match) => Number(match[1]));
    expect(shown).toEqual(Array.from({ length: FORGE_MAX_COMMENTS }, (_, i) => i + 20));
    expect(result.content).toEndWith("```\n20 earlier comment(s) not shown");
  });
  test("AC-7 caps body at FORGE_COMMENT_CHARS", async () => {
    _forgeToolsDeps.listPrComments = mock(async () => [
      comment(0, { body: `${"q".repeat(FORGE_COMMENT_CHARS)}EXCESS` }),
    ]);
    const result = await (await tool()).run({}, ctx);
    expect(result.content).toContain("q".repeat(FORGE_COMMENT_CHARS));
    expect(result.content).not.toContain("EXCESS");
    expect(result.content.match(/q/g)).toHaveLength(FORGE_COMMENT_CHARS);
  });
  test("AC-8 fences hostile author and triple-backtick body together", async () => {
    _forgeToolsDeps.listPrComments = mock(async () => [comment(0, { author: "writer```", body: "body``` hostile" })]);
    const result = await (await tool()).run({}, ctx);
    expect(result.content).toBe(`PR comments\n${markdownFence("writer```:\nbody``` hostile")}`);
  });
  test("AC-9 permission failure withholds repeated login and warns once", async () => {
    const logger = initLogger({ level: "error", suppressConsole: true });
    const warn = spyOn(logger, "warn");
    _forgeToolsDeps.hasWriteAccess = mock(async () => {
      throw new Error("boom");
    });
    _forgeToolsDeps.listPrComments = mock(async () => [
      comment(0, { author: "x", body: "SECRET" }),
      comment(1, { author: "x" }),
    ]);
    const handler = await tool();
    const result = await handler.run({}, ctx);
    await handler.run({}, ctx);
    expect(result.isError).not.toBe(true);
    expect(result.content).not.toContain("SECRET");
    expect(result.content).not.toContain("body-1!");
    expect(result.content).toContain("withheld 2 comment(s)");
    expect(_forgeToolsDeps.hasWriteAccess).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("forge-tools");
    expect(JSON.stringify(warn.mock.calls[0])).toContain("x");
  });
  test("AC-10 read failure resolves isError with redacted first nonempty line", async () => {
    _forgeToolsDeps.listPrComments = mock(async () => {
      throw new Error("\npostgres://user:synthetic_password_123@db\nprivate details");
    });
    const result = await (await tool()).run({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("[REDACTED]");
    expect(result.content).not.toContain("synthetic_password_123");
    expect(result.content).not.toContain("private details");
    expect(result.content).not.toContain("\n");
  });
  test("authorizes before capping, preserves footer order and fitter notice", async () => {
    _forgeToolsDeps.listPrComments = mock(async () => [
      ...Array.from({ length: 70 }, (_, i) => comment(i)),
      comment(100, { author: "outsider" }),
    ]);
    const handler = await tool();
    const footer = "20 earlier comment(s) not shown\nwithheld 1 comment(s) from authors without write access";
    expect((await handler.run({}, ctx)).content).toEndWith(footer);
    const small = await handler.run({}, { ...ctx, maxBytes: 250 });
    expect(small.content).toContain(`\n${footer}\n[truncated:`);
    expect(small.content).toContain("body-20!");
    expect(Buffer.byteLength(small.content)).toBeLessThanOrEqual(250);
  });
  test("shares writer cache with threads and forwards GitLab identity", async () => {
    const provider = createForgeReadProvider(binding);
    await (await tool(provider)).run({}, ctx);
    _forgeToolsDeps.listReviewThreads = mock(async () => [
      { id: "t", replyTo: "t", resolved: false, outdated: false, comments: [comment()] },
    ]);
    const threads = (await provider.tools(ctx.root)).find((entry) => entry.localName === "threads");
    assertDefined(threads);
    await threads.run({}, ctx);
    expect(_forgeToolsDeps.hasWriteAccess).toHaveBeenCalledTimes(1);
    expect(_forgeToolsDeps.hasWriteAccess).toHaveBeenCalledWith(ref, { login: "writer", id: 42 }, deps, "/bound");
    await (await tool()).run({}, ctx);
    expect(_forgeToolsDeps.hasWriteAccess).toHaveBeenCalledTimes(2);
  });
  test("rejects input fields before resolving or reading", async () => {
    const resolveRef = mock(async () => ref);
    const result = await (await tool(createForgeReadProvider({ ...binding, resolveRef }))).run({ extra: true }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("extra");
    expect(resolveRef).not.toHaveBeenCalled();
    expect(_forgeToolsDeps.listPrComments).not.toHaveBeenCalled();
  });
});
