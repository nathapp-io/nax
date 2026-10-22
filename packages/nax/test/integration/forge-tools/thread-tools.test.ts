import { afterEach, expect, mock, test } from "bun:test";
import { resolveProviderTools, type ToolRunContext } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import type { ForgeDeps, PrRef } from "@/forge";
import { _forgeToolsDeps, createForgeReadProvider } from "@/forge-tools";

const original = { ..._forgeToolsDeps };
afterEach(() => Object.assign(_forgeToolsDeps, original));
test("AC-6 resolved provider threads uses bound PrRef, deps and cwd, not execution root", async () => {
  const ref: PrRef = { forge: "github", host: "github.com", repo: "owner/repo", number: 71 };
  const deps: ForgeDeps = {
    run: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    readText: async () => null,
  };
  _forgeToolsDeps.listReviewThreads = mock(async () => []);
  const ctx: ToolRunContext = { root: "/different-worktree", resolvedPaths: [], maxBytes: 2000, maxFileBytes: 2000 };
  const resolved = await resolveProviderTools(
    [createForgeReadProvider({ resolveRef: async () => ref, deps, cwd: "/bound" })],
    "run",
    ctx.root,
  );
  const handler = resolved.tools.find((entry) => entry.name === "nax-forge__threads");
  assertDefined(handler);
  const result = await handler.run({}, ctx);
  expect(result.isError).not.toBe(true);
  expect(_forgeToolsDeps.listReviewThreads).toHaveBeenCalledWith(ref, deps, "/bound");
});
