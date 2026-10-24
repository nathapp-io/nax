import { afterEach, describe, expect, mock, test } from "bun:test";
import { botGit } from "@/bot/git";
import { _sessionPinDeps, pinBaseForSession } from "@/bot/session-pin";
import { NaxError } from "@/errors";

const original = { ..._sessionPinDeps };
afterEach(() => {
  Object.assign(_sessionPinDeps, original);
});
function stub(files = "CLAUDE.md\0", failure = "") {
  const run = mock(async (args: string[]) => ({
    exitCode: args[0] === failure ? 1 : 0,
    stdout: args[0] === "ls-tree" ? files : "",
    stderr: args[0] === failure ? "git failed" : "",
  }));
  _sessionPinDeps.runGit = run;
  _sessionPinDeps.rm = mock(async () => {});
  return run;
}

describe("pinBaseForSession", () => {
  test("AC-14 uses botGit by identity", () => {
    expect(_sessionPinDeps.runGit).toBe(botGit);
  });
  test("AC-15 empty trees only require two recursive NUL listings", async () => {
    const run = stub("src/a.ts\0");
    const pin = await pinBaseForSession("/fixture", "base");
    expect(pin.paths).toEqual([]);
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["ls-tree", "-r", "--name-only", "-z", "HEAD"],
      ["ls-tree", "-r", "--name-only", "-z", "base"],
    ]);
  });
  test("AC-16 uses literal pathspecs but plain update-index paths", async () => {
    const run = stub();
    const pin = await pinBaseForSession("/fixture", "base");
    await pin.restore();
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["ls-tree", "-r", "--name-only", "-z", "HEAD"],
      ["ls-tree", "-r", "--name-only", "-z", "base"],
      ["checkout", "base", "--", ":(literal)CLAUDE.md"],
      ["reset", "-q", "HEAD", "--", ":(literal)CLAUDE.md"],
      ["update-index", "--skip-worktree", "--", "CLAUDE.md"],
      ["update-index", "--no-skip-worktree", "--", "CLAUDE.md"],
      ["reset", "-q", "HEAD", "--", ":(literal)CLAUDE.md"],
      ["ls-tree", "-r", "--name-only", "-z", "HEAD"],
      ["checkout", "HEAD", "--", ":(literal)CLAUDE.md"],
    ]);
  });
  test("AC-17 maps failed checkout to pin NaxError", async () => {
    stub("CLAUDE.md\0", "checkout");
    const promise = pinBaseForSession("/fixture", "base");
    await expect(promise).rejects.toBeInstanceOf(NaxError);
    await expect(promise).rejects.toMatchObject({ code: "BOT_SESSION_PIN_FAILED", context: { stage: "bot-fix" } });
  });
  test("AC-18 maps restore git failure to restore NaxError", async () => {
    stub();
    const pin = await pinBaseForSession("/fixture", "base");
    stub("CLAUDE.md\0", "update-index");
    await expect(pin.restore()).rejects.toMatchObject({
      code: "BOT_SESSION_RESTORE_FAILED",
      context: { stage: "bot-fix" },
    });
  });
});
