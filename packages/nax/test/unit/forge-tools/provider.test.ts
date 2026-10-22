import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ToolProvider, ToolRunContext } from "@nathapp/nax-agent";
import type { ForgeDeps, PrInfo, PrRef } from "@/forge";
import {
  _forgeToolsDeps,
  createForgeReadProvider,
  FORGE_READ_PROVIDER_ID,
  forgeReadProviderForUrl,
} from "@/forge-tools";
import { buildForgeReadInstructions } from "@/prompts";

const ref: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 7 };
const info: PrInfo = {
  number: 7,
  title: "title ``` hostile",
  body: "PRIVATE BODY",
  url: "https://github.com/o/r/pull/7",
  state: "open",
  draft: true,
  author: { login: "writer" },
  baseRef: "main",
  headRef: "fix",
  headSha: "abc",
  crossRepo: false,
};
const deps: ForgeDeps = {
  run: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  readText: async () => null,
};
const ctx: ToolRunContext = { root: "/different-worktree", resolvedPaths: [], maxBytes: 2_000, maxFileBytes: 2_000 };
const original = { ..._forgeToolsDeps };
async function call(provider: ToolProvider, input: Record<string, unknown> = {}) {
  const tool = (await provider.tools(ctx.root)).find((entry) => entry.localName === "pr");
  if (!tool) throw new Error("provider must expose pr for bound reads");
  return tool.run(input, ctx);
}
beforeEach(() => {
  _forgeToolsDeps.readPrInfo = mock(async () => info);
  _forgeToolsDeps.resolvePrRef = mock(async () => ref);
});
afterEach(() => Object.assign(_forgeToolsDeps, original));

describe("createForgeReadProvider", () => {
  test("AC-1/2/3 supplies static metadata and shared instructions", async () => {
    const provider = createForgeReadProvider({ resolveRef: async () => ref, deps, cwd: "/repo" });
    expect(FORGE_READ_PROVIDER_ID).toBe("nax-forge");
    expect(provider.id).toBe(FORGE_READ_PROVIDER_ID);
    expect(provider.kind).toBe("static");
    expect(provider.stages).toEqual(["*"]);
    expect(await provider.instructions?.(ctx.root)).toBe(buildForgeReadInstructions());
  });
  test("AC-4 shares successful and in-flight resolution, using binding context", async () => {
    const resolveRef = mock(async () => ref);
    const provider = createForgeReadProvider({ resolveRef, deps, cwd: "/repo" });
    const results = await Promise.all([call(provider), call(provider)]);
    await call(provider);
    expect(resolveRef).toHaveBeenCalledTimes(1);
    expect(_forgeToolsDeps.readPrInfo).toHaveBeenCalledWith(ref, deps, "/repo");
    expect(results[0].isError).not.toBe(true);
    expect(results[0].content).toContain("title ``` hostile");
    expect(results[0].content).not.toContain(info.body);
  });
  test("AC-5/6/15 returns resolution error without reads and retries next call", async () => {
    let attempts = 0;
    const resolveRef = mock(async () => {
      if (++attempts === 1) throw new Error("boom");
      return ref;
    });
    const provider = createForgeReadProvider({ resolveRef, deps, cwd: "/repo" });
    const spies = [
      "readPrInfo",
      "listHeadChecks",
      "readJobLog",
      "listReviewThreads",
      "listPrComments",
      "hasWriteAccess",
    ] as const;
    const calls = spies.map((key) => spyOn(_forgeToolsDeps, key));
    // With no resolved reference the shared seam must remain entirely untouched.
    const first = await call(provider);
    expect(first).toEqual({ isError: true, content: "boom" });
    expect(_forgeToolsDeps.readPrInfo).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    for (const spy of calls) expect(spy).not.toHaveBeenCalled();
    expect((await call(provider)).isError).not.toBe(true);
    expect(resolveRef).toHaveBeenCalledTimes(2);
  });
  test("AC-16 catches forge exceptions, selects first non-empty line and redacts", async () => {
    _forgeToolsDeps.readPrInfo = mock(async () => {
      throw new Error("\n\npostgres://user:synthetic_password_123@db\nprivate second line");
    });
    const result = await call(createForgeReadProvider({ resolveRef: async () => ref, deps, cwd: "/repo" }));
    expect(result).toEqual({ isError: true, content: "[REDACTED]db" });
  });
  test("validates unknown binding overrides before resolving", async () => {
    const resolveRef = mock(async () => ref);
    const result = await call(createForgeReadProvider({ resolveRef, deps, cwd: "/repo" }), { repo: "attacker/repo" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("repo");
    expect(resolveRef).not.toHaveBeenCalled();
    expect(_forgeToolsDeps.readPrInfo).not.toHaveBeenCalled();
  });
});

describe("forgeReadProviderForUrl", () => {
  test("AC-7 resolves number using seam and binding cwd, not run root", async () => {
    await call(forgeReadProviderForUrl("https://github.com/o/r/pull/7", deps, "/repo"));
    expect(_forgeToolsDeps.resolvePrRef).toHaveBeenCalledWith(7, deps, "/repo");
  });
  test("AC-8/9 rejects URL with no PR number without calling resolution seam", async () => {
    const url = "https://example.com/no-number";
    const result = await call(forgeReadProviderForUrl(url, deps, "/repo"));
    expect(result.isError).toBe(true);
    expect(result.content).toContain(url);
    expect(_forgeToolsDeps.resolvePrRef).not.toHaveBeenCalled();
    expect(_forgeToolsDeps.readPrInfo).not.toHaveBeenCalled();
  });
});
