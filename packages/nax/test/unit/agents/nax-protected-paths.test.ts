import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _codingToolSupportDeps } from "@/agents/coding-tool-support-resolve";
import { naxProtectedPaths } from "@/agents/nax-protected-paths";
import { globalConfigDir, PROJECT_NAX_DIR } from "@/config";
import { trustStorePath } from "@/trust";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";
import { NAX_OWNED_GIT_EXCLUDE_PATHSPECS } from "@/utils/nax-owned-paths";

const ENV = "NAX_GLOBAL_CONFIG_DIR";
const previous = process.env[ENV];
afterEach(() => {
  if (previous === undefined) delete process.env[ENV];
  else process.env[ENV] = previous;
});

describe("naxProtectedPaths — nax's knowledge, supplied to the tools and the sandbox", () => {
  test("is built from nax's own path definitions", () => {
    const policy = naxProtectedPaths();
    expect(policy.gitExcludePathspecs).toBe(NAX_OWNED_GIT_EXCLUDE_PATHSPECS);
    expect(policy.gitIgnorePatterns).toBe(NAX_GITIGNORE_ENTRIES);
    expect(policy.projectStateDir).toBe(PROJECT_NAX_DIR);
    expect(policy.credentialDir).toBe(globalConfigDir());
    expect(policy.trustStoreFile).toBe(trustStorePath());
  });

  test("naxProtectedPaths follows NAX_GLOBAL_CONFIG_DIR live", () => {
    process.env[ENV] = "/tmp/nax-protected-a";
    const first = naxProtectedPaths();
    process.env[ENV] = "/tmp/nax-protected-b";
    const second = naxProtectedPaths();
    expect(first.credentialDir).toBe("/tmp/nax-protected-a");
    expect(second.credentialDir).toBe("/tmp/nax-protected-b");
    expect(second.trustStoreFile.startsWith(join("/tmp/nax-protected-b"))).toBe(true);
  });

  test("is the default the dispatch resolver supplies", () => {
    expect(_codingToolSupportDeps.protectedPaths).toBe(naxProtectedPaths);
  });
});
