/**
 * US-002 AC-17…AC-20: `steps.workProduced` as `buildStoryEnv` wires it, against a **real** temporary
 * repository. The behaviour under test is git's — what `git diff --name-only` reports, what
 * `git status --porcelain` hides — so a faked `_workflowDeps.git` would only assert our own argv
 * back at us.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import { listUncommitted } from "@/workflow/git";
import { buildStoryEnv } from "@/workflow/stage-env";
import type { StoryLoopEnv } from "@/workflow/story-loop";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
  return out.trim();
}

/** A repo with one commit and a clean tree. `src/app.ts` is the only source file. */
async function repo(): Promise<string> {
  const dir = makeTempDir("wf-nowork-");
  dirs.push(dir);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await Bun.write(join(dir, "src/app.ts"), "export const app = 1;\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "seed");
  return dir;
}

/** `base` is the story's git ref; omitted means the story base is HEAD. */
async function storyEnv(projectDir: string, base?: string) {
  const outputDir = makeTempDir("wf-nowork-out-");
  dirs.push(outputDir);
  const config = makeNaxConfig({ outputDir });
  const runtime = makeMockRuntime({ config, workdir: projectDir });
  const ctx = makeTestContext({
    config,
    rootConfig: config,
    runtime,
    projectDir,
    workdir: projectDir,
    ...(base === undefined ? {} : { storyGitRef: base }),
  });
  return buildStoryEnv(ctx, makeMockCallContext({ runtime }));
}

async function producedWork(env: StoryLoopEnv): Promise<boolean> {
  const step = env.steps.workProduced;
  if (!step) throw new Error("buildStoryEnv did not wire steps.workProduced");
  return await step();
}

const commit = async (dir: string, message: string): Promise<void> => {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", message);
};

describe("steps.workProduced (US-002)", () => {
  test("AC-17: HEAD equals the base, the tree is clean and there is no report -> false", async () => {
    const dir = await repo();
    const { env } = await storyEnv(dir);
    // buildStoryEnv's own ledger and result.json are .nax-owned, and .nax-owned paths never count.
    expect(await producedWork(env)).toBe(false);
  });

  test("AC-18: a commit changing a source file on top of the base -> true", async () => {
    const dir = await repo();
    const base = await git(dir, "rev-parse", "HEAD");
    await Bun.write(join(dir, "src/app.ts"), "export const app = 2;\n");
    await commit(dir, "change app");
    const { env } = await storyEnv(dir, base);
    expect(await producedWork(env)).toBe(true);
  });

  test("AC-19: nothing but report.md at sc.reportPath -> true", async () => {
    const dir = await repo();
    const { env, sc } = await storyEnv(dir);
    await Bun.write(sc.reportPath, "# report\n");
    // The report lives under .nax/, so git cannot see it and `listUncommitted` filters it:
    // the report check is the only thing that can make this true.
    expect(sc.reportPath.startsWith(join(dir, ".nax"))).toBe(true);
    expect(await listUncommitted(dir)).toEqual([]);
    expect(await producedWork(env)).toBe(true);
  });

  test("AC-20: a commit changing only a .nax-owned file on top of the base -> false", async () => {
    const dir = await repo();
    const base = await git(dir, "rev-parse", "HEAD");
    await Bun.write(join(dir, ".nax/features/test-feature/notes.txt"), "hand-written\n");
    await commit(dir, "nax-owned note");
    // The commit really happened and really touched only a .nax path.
    expect(await git(dir, "show", "--name-only", "--format=", "HEAD")).toBe(".nax/features/test-feature/notes.txt");
    const { env } = await storyEnv(dir, base);
    expect(await producedWork(env)).toBe(false);
  });
});
