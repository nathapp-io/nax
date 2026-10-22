import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { _baseConfigDeps, botGit, loadBotConfig, snapshotBaseNax } from "@/bot";
import { NaxError } from "@/errors";

const original = { ..._baseConfigDeps };
afterEach(() => Object.assign(_baseConfigDeps, original));

describe("snapshotBaseNax", () => {
  test("archive timeout names the kill and preserves error detail", async () => {
    _baseConfigDeps.runGit = async (argv) =>
      argv[0] === "ls-tree"
        ? { exitCode: 0, stdout: ".nax\0", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "", timedOut: true };
    await expect(snapshotBaseNax("/repo", "sha", "/dest")).rejects.toMatchObject({
      message: "[bot] Failed to archive base config: git timed out",
      context: { timedOut: true },
    });
  });
  test("missing tar keeps extraction NaxError instead of cleanup ENOENT", async () => {
    const { makeTempDir, cleanupTempDir } = await import("@test/helpers");
    const dir = makeTempDir("bot-extract-");
    try {
      await expect(_baseConfigDeps.extractTar(`${dir}/missing.tar`, dir)).rejects.toMatchObject({
        code: "BOT_BASE_CONFIG_READ_FAILED",
      });
    } finally {
      cleanupTempDir(dir);
    }
  });
  test("F1: default git runner uses the shared timeout and SIGKILL implementation", () => {
    expect(_baseConfigDeps.runGit).toBe(botGit);
  });

  test("AC-6: invalid object names fail with a contextual NaxError", async () => {
    _baseConfigDeps.runGit = mock(async () => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a valid object name",
    }));
    const result = snapshotBaseNax("/repo", "bad-sha", "/dest");
    await expect(result).rejects.toBeInstanceOf(NaxError);
    await expect(result).rejects.toMatchObject({ code: "BOT_BASE_CONFIG_READ_FAILED" });
  });

  test("AC-7: extraction errors are wrapped and preserve their cause", async () => {
    _baseConfigDeps.runGit = mock(async (argv) => ({
      exitCode: 0,
      stdout: argv[0] === "ls-tree" ? ".nax\0" : "",
      stderr: "",
    }));
    const cause = new Error("broken tar");
    _baseConfigDeps.extractTar = mock(async () => {
      throw cause;
    });
    const result = snapshotBaseNax("/repo", "base-sha", "/dest");
    await expect(result).rejects.toBeInstanceOf(NaxError);
    await expect(result).rejects.toMatchObject({ code: "BOT_BASE_CONFIG_READ_FAILED", context: { cause } });
    expect(_baseConfigDeps.runGit).toHaveBeenCalledWith(
      ["archive", "--format=tar", "--output", "/dest/base.tar", "base-sha", ".nax"],
      "/repo",
    );
    expect(_baseConfigDeps.extractTar).toHaveBeenCalledWith("/dest/base.tar", "/dest");
  });
});

describe("loadBotConfig", () => {
  test.each([
    ["AC-9", ["a", "b"], { profile: ["a", "b"] }],
    ["AC-10", [], undefined],
  ] as const)("%s: forwards snapshot and profile options", async (_ac, profiles, options) => {
    const config = makeNaxConfig();
    const load = mock(async () => config);
    _baseConfigDeps.loadConfig = load;
    expect(await loadBotConfig({ snapshotDir: "/s", profiles })).toBe(config);
    expect(load).toHaveBeenCalledWith("/s", options);
  });
});
