import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { gitWithTimeout } from "@/utils/git";
import { hardenedGitEnv } from "@/utils/git-env";

describe("hardenedGitEnv", () => {
  test("adds core.fsmonitor=false as config entry 0 when none are set", () => {
    const env = hardenedGitEnv({ PATH: "/bin" });
    expect(env).toEqual({
      PATH: "/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
    });
  });

  test("appends after the caller's own GIT_CONFIG_COUNT entries, keeping them", () => {
    const env = hardenedGitEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" });
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(env.GIT_CONFIG_KEY_1).toBe("core.fsmonitor");
    expect(env.GIT_CONFIG_VALUE_1).toBe("false");
  });

  test("a malformed existing count is left untouched", () => {
    expect(hardenedGitEnv({ GIT_CONFIG_COUNT: "abc" })).toEqual({ GIT_CONFIG_COUNT: "abc" });
  });

  test("does not mutate its input", () => {
    const base = { PATH: "/bin" };
    hardenedGitEnv(base);
    expect(base).toEqual({ PATH: "/bin" });
  });
});

describe("gitWithTimeout: #2198 fsmonitor hardening", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir("git-env-");
  });
  afterEach(() => cleanupTempDir(dir));

  test("a repo-configured core.fsmonitor program is never run by nax's git", async () => {
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    const marker = join(dir, "fsmonitor-ran");
    const hook = join(dir, "fsmonitor.sh");
    await Bun.write(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    Bun.spawnSync(["chmod", "+x", hook]);
    Bun.spawnSync(["git", "config", "core.fsmonitor", hook], { cwd: dir });
    const r = await gitWithTimeout(["status", "--porcelain"], dir);
    expect(r.exitCode).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
