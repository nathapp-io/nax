import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { activateRunState, type RunStateHandle, repairRunState } from "@/runstate";
import { gitWithTimeout } from "@/utils/git";
import { atomicWriteText } from "@/utils/json-file";

const PRD = ".nax/features/f/prd.json";
const STATUS = ".nax/features/f/status.json";
const NAX_PRD = '{"stories":"nax"}';
const NAX_STATUS = '{"status":"running"}';
let dir: string;
let handle: RunStateHandle;

async function git(...args: string[]): Promise<string> {
  return (await gitWithTimeout(args, dir)).stdout;
}

/** Parent GIT_DIR / GIT_WORK_TREE would redirect the command to the wrong repo. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "GIT_DIR" && k !== "GIT_WORK_TREE") base[k] = v;
  }
  return { ...base, ...extra };
}

async function sh(cmd: string, env: Record<string, string> = {}): Promise<void> {
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd: dir, env: cleanEnv(env), stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

beforeEach(async () => {
  dir = makeTempDir();
  for (const a of [
    ["init", "-q"],
    ["config", "user.email", "t@example.com"],
    ["config", "user.name", "t"],
  ])
    await git(...a);
  mkdirSync(join(dir, ".nax/features/f"), { recursive: true });
  writeFileSync(join(dir, PRD), '{"stories":"seed"}');
  writeFileSync(join(dir, "a.txt"), "1\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed");
  writeFileSync(join(dir, "a.txt"), "2\n");
  await git("commit", "-q", "-am", "second");
  handle = await activateRunState({ runId: "r1", feature: "f", root: dir });
  await atomicWriteText(join(dir, PRD), NAX_PRD); // tracked + modified: a revert loses nax's write
  await atomicWriteText(join(dir, STATUS), NAX_STATUS); // untracked: a clean/stash/rm loses it
});

afterEach(() => {
  handle.deactivate();
  cleanupTempDir(dir);
});

const read = (rel: string) =>
  Bun.file(join(dir, rel))
    .text()
    .catch(() => "<missing>");

async function expectRepaired(): Promise<void> {
  const records = await repairRunState({
    trigger: "turn",
    storyId: "US-001",
    sessionName: "s1",
    stage: "implementer",
    turn: 1,
  });
  expect(records.length).toBeGreaterThan(0);
  expect(records.every((r) => r.restored)).toBe(true);
  expect(await read(PRD)).toBe(NAX_PRD);
  expect(await read(STATUS)).toBe(NAX_STATUS);
  expect(await git("ls-files", "-v", "--", PRD)).toMatch(/^H /);
}

/** Each case first proves the command really damaged the state, then that repair undid it. */
const CASES: { name: string; cmd: string; env?: Record<string, string>; damaged: () => Promise<boolean> }[] = [
  { name: "alias to stash", cmd: "git -c alias.x='stash -u' x", damaged: async () => (await read(PRD)) !== NAX_PRD },
  {
    name: "shell alias checkout",
    cmd: "git -c 'alias.x=!git checkout -- .nax' x",
    damaged: async () => (await read(PRD)) !== NAX_PRD,
  },
  {
    name: "rebase -x deletes status",
    cmd: "git stash -q && git rebase -q -x 'rm -f .nax/features/f/status.json' HEAD~1; git stash pop -q",
    damaged: async () => (await read(STATUS)) === "<missing>",
  },
  {
    name: "GIT_EXTERNAL_DIFF executes",
    cmd: "git diff --ext-diff",
    env: { GIT_EXTERNAL_DIFF: "sh -c 'git checkout -- .nax/features/f/prd.json' --" },
    damaged: async () => (await read(PRD)) !== NAX_PRD,
  },
  {
    name: "interpreter overwrite",
    cmd: "bun -e \"await Bun.write('.nax/features/f/prd.json', '{}')\"",
    damaged: async () => (await read(PRD)) === "{}",
  },
  {
    name: "rm status",
    cmd: "rm .nax/features/f/status.json",
    damaged: async () => (await read(STATUS)) === "<missing>",
  },
  {
    name: "exclude pathspec that does not exclude",
    cmd: "git checkout -- . ':(exclude,glob)**/.nax'",
    damaged: async () => (await read(PRD)) !== NAX_PRD,
  },
  {
    name: "skip-worktree",
    cmd: "git update-index --skip-worktree .nax/features/f/prd.json",
    damaged: async () => (await git("ls-files", "-v", "--", PRD)).startsWith("S "),
  },
  {
    name: "assume-unchanged",
    cmd: "git update-index --assume-unchanged .nax/features/f/prd.json",
    damaged: async () => /^[a-z] /.test(await git("ls-files", "-v", "--", PRD)),
  },
  {
    name: "stash -u with only .nax dirty",
    cmd: "git stash -u",
    damaged: async () => (await read(STATUS)) === "<missing>",
  },
  { name: "clean -fdx", cmd: "git clean -fdxq", damaged: async () => (await read(STATUS)) === "<missing>" },
];

describe("run-state bypass matrix: repair, not refusal (#2497)", () => {
  test.each(CASES)("$name", async ({ cmd, env, damaged }) => {
    await sh(cmd, env);
    expect(await damaged()).toBe(true);
    await expectRepaired();
  });
});
