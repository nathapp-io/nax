import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { _savedFixDeps, clearSavedFix, persistSavedFix, readSavedFix, saveFix } from "@/bot/saved-fix";

import { getLogger } from "@/logger";

const original = { ..._savedFixDeps };
afterEach(() => Object.assign(_savedFixDeps, original));
const sha = "a".repeat(40);
const headSha = "b".repeat(40);
const entry = {
  version: 1 as const,
  sha,
  headSha,
  agreedKeys: ["a"],
  outcome: "baseline-red" as const,
  savedAt: "2026-10-22T03:00:00.000Z",
};
const location = { outputDir: "/output", repoRoot: "/repo", prNumber: 42 };

describe("readSavedFix", () => {
  test("missing entry is silent but unreadable and corrupt entries warn", async () => {
    const warn = spyOn(getLogger(), "warn");
    try {
      _savedFixDeps.readText = async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      };
      expect(await readSavedFix("/output", 42)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      _savedFixDeps.readText = async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      };
      expect(await readSavedFix("/output", 42)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      _savedFixDeps.readText = async () => "{}";
      expect(await readSavedFix("/output", 42)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
  test("AC-15 returns a valid version 1 entry", async () => {
    _savedFixDeps.readText = async () => JSON.stringify(entry);
    expect(await readSavedFix("/output", 42)).toEqual(entry);
  });
  test.each([
    { ...entry, version: 2 },
    { ...entry, sha: "bad" },
    { ...entry, headSha: "bad" },
    { ...entry, agreedKeys: [1] },
    { ...entry, outcome: "pushed" },
    { ...entry, savedAt: "yesterday" },
    {},
  ])("AC-14 returns null for invalid schema %j", async (value) => {
    _savedFixDeps.readText = async () => JSON.stringify(value);
    expect(await readSavedFix("/output", 42)).toBeNull();
  });
  test("returns null for missing and malformed files", async () => {
    _savedFixDeps.readText = async () => {
      throw new Error("missing");
    };
    expect(await readSavedFix("/output", 42)).toBeNull();
    _savedFixDeps.readText = async () => "{";
    expect(await readSavedFix("/output", 42)).toBeNull();
  });
});

describe("persistSavedFix", () => {
  test.each([
    { outcome: "protected", fixSha: sha },
    { outcome: "nothing", fixSha: sha },
    { outcome: "baseline-red", fixSha: headSha },
    { outcome: "baseline-red", fixSha: undefined },
  ] as const)("AC-8/9/10/11 skips HEAD and save for %j", async (state) => {
    const base = makeBotFixEnv();
    const env = { ...base, info: { ...base.info, headSha } };
    const runGit = mock(original.runGit);
    const save = mock(async () => {});
    _savedFixDeps.runGit = runGit;
    await persistSavedFix({
      env,
      state: { step: "done", timings: {}, ...state },
      outputDir: "/output",
      savedFix: { save, clear: async () => {} },
    });
    expect(runGit).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  test("does not persist a guessed sha when reading HEAD fails", async () => {
    const env = makeBotFixEnv();
    const save = mock(async () => {});
    _savedFixDeps.runGit = async () => ({ exitCode: 1, stdout: "", stderr: "HEAD unavailable" });
    await persistSavedFix({
      env,
      state: { step: "done", timings: {}, outcome: "baseline-red", fixSha: sha },
      outputDir: "/output",
      savedFix: { save, clear: async () => {} },
    });
    expect(save).not.toHaveBeenCalled();
  });
  test.each(["cost-limit", "push-rejected", "push-unknown", "gates-failed"] as const)(
    "AC-6 %s saves a distinct commit",
    async (outcome) => {
      const base = makeBotFixEnv();
      const env = { ...base, info: { ...base.info, headSha } };
      const save = mock(saveFix);
      // Isolate the save call; no git or disk mutation is allowed in this unit test.
      save.mockImplementation(async () => {});
      _savedFixDeps.runGit = async () => ({ exitCode: 0, stdout: sha, stderr: "" });
      await persistSavedFix({
        env,
        state: { step: "done", timings: {}, outcome, fixSha: sha },
        outputDir: "/output",
        savedFix: { save, clear: async () => {} },
      });
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]).toEqual([location, expect.objectContaining({ sha, headSha, outcome })]);
    },
  );
  test("swallows an injected save rejection", async () => {
    const env = makeBotFixEnv();
    _savedFixDeps.runGit = async () => ({ exitCode: 0, stdout: sha, stderr: "" });
    await expect(
      persistSavedFix({
        env,
        state: { step: "done", timings: {}, outcome: "cost-limit", fixSha: sha },
        outputDir: "/output",
        savedFix: {
          clear: async () => {},
          save: async () => {
            throw new Error("save failed");
          },
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("clearSavedFix", () => {
  test("attempts file deletion even when ref deletion throws", async () => {
    _savedFixDeps.runGit = async () => {
      throw new Error("git failed");
    };
    const remove = mock(async () => {});
    _savedFixDeps.remove = remove;
    await clearSavedFix(location);
    expect(remove).toHaveBeenCalledWith("/output/bot/pr-42/saved-fix.json");
  });
});
