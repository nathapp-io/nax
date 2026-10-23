import { afterEach, describe, expect, mock, test } from "bun:test";
import { resolveProviderTools, type ToolRunContext } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import type { ForgeDeps, PrInfo, PrRef } from "@/forge";
import { _forgeToolsDeps, createForgeReadProvider } from "@/forge-tools";

const original = { ..._forgeToolsDeps };
afterEach(() => Object.assign(_forgeToolsDeps, original));

describe("bound head checks through provider advertisement", () => {
  test("AC-5 uses bound ref/deps/cwd and refreshes head without resolving ref again", async () => {
    const ref: PrRef = { forge: "gitlab", host: "git.example.com", repo: "group/project", number: 42 };
    const deps: ForgeDeps = {
      run: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      readText: async () => null,
    };
    const resolveRef = mock(async () => ref);
    let headSha = "abc123";
    _forgeToolsDeps.readPrInfo = mock(
      async (): Promise<PrInfo> => ({
        number: 42,
        title: "MR",
        body: "",
        url: "https://git.example.com/group/project/-/merge_requests/42",
        state: "open",
        draft: false,
        author: { login: "bot" },
        baseRef: "main",
        headRef: "fix",
        headSha,
        crossRepo: false,
      }),
    );
    _forgeToolsDeps.listHeadChecks = mock(async () => []);
    const ctx: ToolRunContext = { root: "/unrelated-root", resolvedPaths: [], maxBytes: 2_000, maxFileBytes: 2_000 };
    const resolved = await resolveProviderTools(
      [createForgeReadProvider({ resolveRef, deps, cwd: "/bound-checkout" })],
      "run",
      ctx.root,
    );
    const checks = resolved.tools.find((entry) => entry.name === "nax-forge__checks");
    const pr = resolved.tools.find((entry) => entry.name === "nax-forge__pr");
    assertDefined(checks);
    assertDefined(pr);
    expect((await checks.run({}, ctx)).isError).not.toBe(true);
    expect(_forgeToolsDeps.readPrInfo).toHaveBeenCalledWith(ref, deps, "/bound-checkout");
    expect(_forgeToolsDeps.listHeadChecks).toHaveBeenNthCalledWith(1, ref, "abc123", deps, "/bound-checkout");
    headSha = "next-head";
    expect((await checks.run({}, ctx)).isError).not.toBe(true);
    expect(_forgeToolsDeps.listHeadChecks).toHaveBeenNthCalledWith(2, ref, "next-head", deps, "/bound-checkout");
    expect((await pr.run({}, ctx)).content).toContain("next-head");
    expect(_forgeToolsDeps.readPrInfo).toHaveBeenCalledTimes(3);
    expect(resolveRef).toHaveBeenCalledTimes(1);
    expect(deps.run).not.toHaveBeenCalled();
  });
});
