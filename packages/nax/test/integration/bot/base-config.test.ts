import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadBotConfig, snapshotBaseNax } from "@/bot";

let repo: string;
let dest: string;

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

beforeEach(async () => {
  repo = makeTempDir("bot-base-repo-");
  dest = makeTempDir("bot-base-snapshot-");
  await git("init");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Bot Test");
});
afterEach(async () => {
  await Promise.all([cleanupTempDir(repo), cleanupTempDir(dest)]);
});

async function commitConfig(): Promise<{ sha: string; content: string }> {
  const content = JSON.stringify({ bot: { models: { review: "fast" } } });
  await Bun.write(join(repo, ".nax/config.json"), content);
  await git("add", ".");
  await git("commit", "-m", "base config");
  return { sha: await git("rev-parse", "HEAD"), content };
}

describe("snapshotBaseNax", () => {
  test("AC-2/3/4/8: extracts committed config, not working-tree edits, and removes tar", async () => {
    const { sha, content } = await commitConfig();
    await Bun.write(join(repo, ".nax/config.json"), '{"bot":{"models":{"review":"powerful"}}}');
    expect(await snapshotBaseNax(repo, sha, dest)).toBe(true);
    expect(await Bun.file(join(dest, ".nax/config.json")).text()).toBe(content);
    expect(await Bun.file(join(dest, "base.tar")).exists()).toBe(false);
  });

  test("AC-5: returns false when base has no .nax directory", async () => {
    await Bun.write(join(repo, "README.md"), "no config");
    await git("add", ".");
    await git("commit", "-m", "empty config base");
    expect(await snapshotBaseNax(repo, await git("rev-parse", "HEAD"), dest)).toBe(false);
    expect(await Bun.file(join(dest, "base.tar")).exists()).toBe(false);
  });
});

describe("loadBotConfig", () => {
  test("AC-11: loads bot model configuration from the base snapshot", async () => {
    const { sha } = await commitConfig();
    await snapshotBaseNax(repo, sha, dest);
    expect((await loadBotConfig({ snapshotDir: dest, profiles: [] })).bot?.models.review).toBe("fast");
  });
});
