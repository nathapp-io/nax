import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resolveProviderTools, type ToolRunContext } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import { writerCheck as botWriterCheck } from "@/bot";
import type { ForgeDeps, PrComment, PrThread } from "@/forge";
import * as forge from "@/forge";
import { _forgeToolsDeps, createForgeReadProvider } from "@/forge-tools";
import { FORGE_COMMENT_CHARS, FORGE_MAX_THREADS } from "@/forge-tools/constants";
import { initLogger, resetLogger } from "@/logger";
import { markdownFence } from "@/utils/markdown-fence";

const ref: forge.PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 7 };
const deps: ForgeDeps = {
  run: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  readText: async () => null,
};
const ctx: ToolRunContext = { root: "/other", resolvedPaths: [], maxBytes: 100_000, maxFileBytes: 100_000 };
const original = { ..._forgeToolsDeps };
const binding = () => ({ resolveRef: mock(async () => ref), deps, cwd: "/bound" });
function comment(author = "writer", body = "writer body"): PrComment {
  return { id: "c", kind: "thread", author, authorId: 42, body, createdAt: "now" };
}
function thread(path = "file.ts", comments = [comment()], resolved = false): PrThread {
  return { id: path, replyTo: path, path, line: 9, resolved, outdated: false, comments };
}
async function tool(provider = createForgeReadProvider(binding())) {
  const found = (await provider.tools(ctx.root)).find((entry) => entry.localName === "threads");
  assertDefined(found);
  return found;
}
beforeEach(() => {
  _forgeToolsDeps.listReviewThreads = mock(async () => [thread()]);
  _forgeToolsDeps.hasWriteAccess = mock(async (_ref, who) => who.login === "writer");
});
afterEach(() => {
  Object.assign(_forgeToolsDeps, original);
  resetLogger();
});

describe("writerCheck forge exports", () => {
  test("AC-1 caches in-flight and settled calls per login", async () => {
    const check = mock(async () => true);
    const cached = forge.writerCheck({ ref, deps, cwd: "/bound" }, check, mock());
    expect(await Promise.all([cached({ login: "x" }), cached({ login: "x" })])).toEqual([true, true]);
    expect(await cached({ login: "x" })).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });
  test("AC-2/3 fails closed and warns once naming the login", async () => {
    const warn = mock();
    const cached = forge.writerCheck(
      { ref, deps, cwd: "/bound" },
      async () => {
        throw new Error("boom");
      },
      warn,
    );
    expect(await cached({ login: "x" })).toBe(false);
    expect(await cached({ login: "x" })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("x", "boom");
  });
  test("AC-4 bot re-exports the identical function", () => {
    expect(forge.writerCheck).toBeDefined();
    expect(botWriterCheck).toBe(forge.writerCheck);
  });
});

describe("threads tool", () => {
  test("AC-5 advertises namespaced threads", async () => {
    const resolved = await resolveProviderTools([createForgeReadProvider(binding())], "run", ctx.root);
    expect(resolved.tools.map((entry) => entry.name)).toContain("nax-forge__threads");
  });
  test("AC-7/8 defaults to unresolved; opt-in includes marked resolved threads", async () => {
    _forgeToolsDeps.listReviewThreads = mock(async () => [thread("open"), thread("closed", [comment("hidden")], true)]);
    const handler = await tool();
    const normal = await handler.run({}, ctx);
    expect(normal.content).toContain("open:9");
    expect(normal.content).not.toContain("closed");
    expect(normal.content).not.toContain("withheld");
    const all = await handler.run({ includeResolved: true }, ctx);
    expect(all.content).toContain("closed:9");
    expect(all.content).toContain("resolved: true");
  });
  test("AC-9/10 shows writers only and counts withheld comments after fence", async () => {
    _forgeToolsDeps.listReviewThreads = mock(async () => [thread("file", [comment(), comment("outsider", "SECRET")])]);
    const result = await (await tool()).run({}, ctx);
    expect(result.content).toContain("writer");
    expect(result.content).toContain("writer body");
    expect(result.content).not.toContain("outsider");
    expect(result.content).not.toContain("SECRET");
    expect(result.content).toEndWith("```\nwithheld 1 comment(s) from authors without write access");
  });
  test("AC-11 omits withheld footer when all authors are writers", async () => {
    expect((await (await tool()).run({}, ctx)).content).not.toContain("withheld");
  });
  test("AC-12 caches one login across threads and subsequent calls, not providers", async () => {
    _forgeToolsDeps.listReviewThreads = mock(async () => [thread("a"), thread("b", [comment(), comment()])]);
    const handler = await tool();
    await handler.run({}, ctx);
    await handler.run({}, ctx);
    expect(_forgeToolsDeps.hasWriteAccess).toHaveBeenCalledTimes(1);
    await (await tool()).run({}, ctx);
    expect(_forgeToolsDeps.hasWriteAccess).toHaveBeenCalledTimes(2);
  });
  test("AC-13 passes GitLab identity and bound context", async () => {
    const gitlab: forge.PrRef = { ...ref, forge: "gitlab", host: "gitlab.com" };
    await (await tool(createForgeReadProvider({ ...binding(), resolveRef: async () => gitlab }))).run({}, ctx);
    expect(_forgeToolsDeps.hasWriteAccess).toHaveBeenCalledWith(gitlab, { login: "writer", id: 42 }, deps, "/bound");
  });
  test("AC-14/15 fails closed and logs one forge-tools warning per failed login", async () => {
    const logger = initLogger({ level: "error", suppressConsole: true });
    const warn = spyOn(logger, "warn");
    _forgeToolsDeps.hasWriteAccess = mock(async () => {
      throw new Error("boom");
    });
    _forgeToolsDeps.listReviewThreads = mock(async () => [
      thread("a", [comment("x", "SECRET"), comment("x", "SECRET")]),
    ]);
    const handler = await tool();
    expect((await handler.run({}, ctx)).content).not.toContain("SECRET");
    await handler.run({}, ctx);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("forge-tools");
    expect(JSON.stringify(warn.mock.calls[0])).toContain("x");
  });
  test("AC-16 caps bodies to FORGE_COMMENT_CHARS", async () => {
    _forgeToolsDeps.listReviewThreads = mock(async () => [
      thread("a", [comment("writer", `${"q".repeat(FORGE_COMMENT_CHARS)}EXCESS`)]),
    ]);
    const result = await (await tool()).run({}, ctx);
    expect(result.content).toContain("q".repeat(FORGE_COMMENT_CHARS));
    expect(result.content).not.toContain("EXCESS");
  });
  test("AC-17 fences hostile locations, flags, authors and bodies together", async () => {
    _forgeToolsDeps.hasWriteAccess = mock(async () => true);
    _forgeToolsDeps.listReviewThreads = mock(async () => [
      thread("path```", [comment("author```", "body``` hostile")]),
    ]);
    const result = await (await tool()).run({}, ctx);
    const payload = result.content.split("\n").slice(2, -1).join("\n");
    expect(payload).toContain("path```:9");
    expect(payload).toContain("outdated: false");
    expect(payload).toContain("author```");
    expect(payload).toContain("body``` hostile");
    expect(result.content).toBe(`Review threads\n${markdownFence(payload)}`);
  });
  test("AC-18 authorizes beyond first 50 and preserves ordered footers under budget truncation", async () => {
    _forgeToolsDeps.listReviewThreads = mock(async () =>
      Array.from({ length: 60 }, (_, i) => thread(`file-${i}`, [comment(i === 55 ? "outsider" : "writer")])),
    );
    const handler = await tool();
    const result = await handler.run({}, ctx);
    expect(result.content).toContain(`file-${FORGE_MAX_THREADS - 1}:9`);
    expect(result.content).not.toContain(`file-${FORGE_MAX_THREADS}:9`);
    const footer = "10 more thread(s) not shown\nwithheld 1 comment(s) from authors without write access";
    expect(result.content).toEndWith(footer);
    const small = await handler.run({}, { ...ctx, maxBytes: 400 });
    expect(small.content).toContain(`\n${footer}\n[truncated:`);
    expect(Buffer.byteLength(small.content)).toBeLessThanOrEqual(400);
  });
  test("AC-19 retains location when every comment is withheld", async () => {
    _forgeToolsDeps.listReviewThreads = mock(async () => [thread("retained", [comment("outsider")])]);
    const result = await (await tool()).run({}, ctx);
    expect(result.content).toContain("retained:9");
    expect(result.content).toContain("(no comments from writers)");
  });
  test.each(["true", 1, null, [], {}])(
    "AC-20/21 rejects invalid includeResolved %j before any forge call",
    async (value) => {
      const bound = binding();
      const keys = [
        "resolvePrRef",
        "readPrInfo",
        "listHeadChecks",
        "readJobLog",
        "listReviewThreads",
        "listPrComments",
        "hasWriteAccess",
      ] as const;
      const spies = keys.map((key) => spyOn(_forgeToolsDeps, key));
      const result = await (await tool(createForgeReadProvider(bound))).run({ includeResolved: value }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("includeResolved");
      expect(bound.resolveRef).not.toHaveBeenCalled();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    },
  );
});
