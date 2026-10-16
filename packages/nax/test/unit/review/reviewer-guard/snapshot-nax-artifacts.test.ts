import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKeeperOwnedPath, restoreRepoSnapshot, takeRepoSnapshot } from "@/review/reviewer-guard";
import {
  classifyRunStatePath,
  RunStateKeeper,
  registerKeeper,
  runStateWrite,
  unregisterKeeper,
} from "@/runstate/store";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";

const dirs: string[] = [];
const keepers: RunStateKeeper[] = [];
afterEach(async () => {
  for (const keeper of keepers.splice(0)) unregisterKeeper(keeper);
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  await p.exited;
}

describe("reviewer guard vs files nax itself writes during a turn (nax#2500 F4)", () => {
  test("keeper predicate covers run-state files only after a live keeper records them", () => {
    const keeper = new RunStateKeeper("test", "f");
    keepers.push(keeper);
    registerKeeper(keeper);
    const feat = ".nax/features/f";
    for (const rel of [
      `${feat}/prd.json`,
      `${feat}/status.json`,
      `${feat}/decisions.jsonl`,
      `${feat}/workflow/run-1/result.json`,
      `${feat}/workflow/run-1/ledger.md`,
      `packages/api/${feat}/prd.json`,
    ]) {
      expect(isKeeperOwnedPath("/repo", rel)).toBe(false);
      const abs = join("/repo", rel);
      const classified = classifyRunStatePath(abs);
      if (!classified) throw new Error(`invalid fixture ${rel}`);
      keeper.record(abs, classified, "{}");
      expect(isKeeperOwnedPath("/repo", rel)).toBe(true);
    }
  });

  test("nax runtime artifacts listed in NAX_GITIGNORE_ENTRIES survive a restore; config and source do not", async () => {
    const d = await mkdtemp(join(tmpdir(), "nax-rguard-art-"));
    dirs.push(d);
    await git(d, "init", "-q", "-b", "main");
    await writeFile(join(d, ".gitignore"), `${NAX_GITIGNORE_ENTRIES.join("\n")}\n`);
    await writeFile(join(d, "a.txt"), "a\n");
    await git(d, "add", "-A");
    await git(d, "commit", "-q", "-m", "seed");
    const snap = await takeRepoSnapshot(d);

    const keeper = new RunStateKeeper("test", "f");
    keepers.push(keeper);
    registerKeeper(keeper);
    const feat = join(snap.toplevel, ".nax", "features", "f");
    await mkdir(join(feat, "stories", "US-1"), { recursive: true });
    await mkdir(join(feat, "sessions"), { recursive: true });
    const written = [
      join(feat, "status.json"),
      join(feat, "checkpoint.jsonl"),
      join(feat, "progress.txt"),
      join(feat, "acp-sessions.json"),
      join(feat, "acceptance-refined.json"),
      join(feat, "stories", "US-1", "session.json"),
      join(feat, "sessions", "s.json"),
      join(d, "nax.lock"),
      join(d, ".nax-pids"),
      join(d, ".nax", "status.json"),
    ];
    for (const p of written) await writeFile(p, "x\n");
    const prd = join(feat, "prd.json");
    await runStateWrite(prd, { content: "{}\n" }, () => writeFile(prd, "{}\n"));
    await writeFile(join(d, "a.txt"), "reviewer\n");

    const report = await restoreRepoSnapshot(snap);
    expect(report.failures).toEqual([]);
    expect(report.paths).toEqual(["a.txt"]);
    for (const p of [...written, join(feat, "prd.json")]) expect(existsSync(p)).toBe(true);
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("a\n");
  });
});
