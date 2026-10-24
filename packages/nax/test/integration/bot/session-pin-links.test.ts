import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import { botGit } from "@/bot/git";
import { _sessionPinDeps, pinBaseForSession } from "@/bot/session-pin";

const original = { ..._sessionPinDeps };
const logger = makeLogger();
const warning = "Skipped pinning a path under a linked or non-directory parent";
let repo: string;
let outside: string;
async function git(args: string[]): Promise<string> {
  const result = await botGit(args, repo);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function commit(message: string): Promise<string> {
  await git(["add", "-A"]);
  await git(["commit", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}
beforeEach(async () => {
  repo = makeTempDir("session-links-");
  outside = makeTempDir("session-outside-");
  logger.reset();
  Object.assign(_sessionPinDeps, { getLogger: () => logger });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.com"]);
  await Bun.write(join(outside, "AGENTS.md"), "outside");
});
afterEach(() => {
  Object.assign(_sessionPinDeps, original);
  cleanupTempDir(repo);
  cleanupTempDir(outside);
});
function warned(path: string): void {
  expect(logger.warn).toHaveBeenCalledWith("bot-fix", warning, { path });
}

describe("pinBaseForSession parent safety", () => {
  test("AC-1 AC-2 skips base instructions below a head symlink at pin and restore", async () => {
    await Bun.write(join(repo, "docs/AGENTS.md"), "base");
    const base = await commit("base");
    await git(["rm", "-r", "docs"]);
    await symlink(outside, join(repo, "docs"));
    await commit("linked head");
    const pin = await pinBaseForSession(repo, base);
    expect(await Bun.file(join(outside, "AGENTS.md")).text()).toBe("outside");
    warned("docs/AGENTS.md");
    await pin.restore();
    expect(await Bun.file(join(outside, "AGENTS.md")).text()).toBe("outside");
    expect(pin.paths).toEqual([]);
  });
  test("AC-3 AC-4 rechecks a directory swapped for a symlink before restore removal and checkout", async () => {
    await Bun.write(join(repo, "docs/AGENTS.md"), "base");
    const base = await commit("base");
    await Bun.write(join(repo, "docs/AGENTS.md"), "head");
    await commit("head");
    const pin = await pinBaseForSession(repo, base);
    expect(await Bun.file(join(repo, "docs/AGENTS.md")).text()).toBe("base");
    await rm(join(repo, "docs"), { recursive: true });
    await symlink(outside, join(repo, "docs"));
    logger.reset();
    await pin.restore();
    expect(await Bun.file(join(outside, "AGENTS.md")).text()).toBe("outside");
    warned("docs/AGENTS.md");
  });
  test("AC-5 AC-6 skips a base instruction below a regular-file parent", async () => {
    await Bun.write(join(repo, ".github/copilot-instructions.md"), "base");
    const base = await commit("base");
    await git(["rm", "-r", ".github"]);
    await Bun.write(join(repo, ".github"), "head file");
    await commit("file head");
    const pin = await pinBaseForSession(repo, base);
    expect(await Bun.file(join(repo, ".github")).text()).toBe("head file");
    warned(".github/copilot-instructions.md");
    await pin.restore();
    expect(await Bun.file(join(repo, ".github")).text()).toBe("head file");
  });
});
