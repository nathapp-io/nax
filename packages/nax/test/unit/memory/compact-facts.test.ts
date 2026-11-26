/**
 * compact-facts.test.ts — what the facts read answers when git fails.
 *
 * Covers AC-10 and AC-11: a failed `git log` leaves `commits` empty and still reads
 * the feature facts, and a failed branch listing leaves `branches` empty. A third
 * case covers the branch where git cannot be run at all (`_compactFactsDeps.git`
 * throws), which is the same best-effort contract reached by a different exit.
 *
 * The fixtures are real repositories with a real `prd.json`; only `git` is stubbed,
 * so each case proves one git failure costs exactly its own list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import { featuresDir } from "@/config";
import { _compactFactsDeps, readMemoryCompactFacts } from "@/memory";
import { gitWithTimeout } from "@/utils/git";

/** The `prd.json` every case writes: one passed story, one pending, one feature. */
const PRD_JSON = JSON.stringify({
  feature: "a",
  userStories: [
    { id: "US-001", title: "first", passes: true, status: "passed", acceptanceCriteria: ["holds"] },
    { id: "US-002", title: "second", passes: false, status: "pending", acceptanceCriteria: ["holds"] },
  ],
});

/** The feature fact every case expects, whatever git answered. */
const FEATURE = { name: "a", passed: 1, total: 2 };

/** What git reports when the command it was given cannot run. */
const GIT_REFUSAL = { stdout: "", stderr: "fatal: git refused", exitCode: 128 };

let root: string;

/** Run one git command for the fixture, throwing when git itself refused. */
async function git(...args: string[]): Promise<string> {
  const { stdout, exitCode, stderr } = await gitWithTimeout(args, root, 30_000);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}

beforeEach(async () => {
  root = makeTempDir("nax-compact-facts-unit-");
  await git("init", "-q");
  await git(
    "-c",
    "user.email=compact-facts@example.invalid",
    "-c",
    "user.name=Compact Facts",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "seed the repository",
  );
  const dir = join(featuresDir(root), "a");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prd.json"), PRD_JSON);
});

afterEach(() => {
  cleanupTempDir(root);
});

describe("readMemoryCompactFacts when git fails", () => {
  withDepsRestore(_compactFactsDeps, ["git", "loadPRD"]);

  // AC-10
  test("returns commits [] and still reads the feature facts when git log fails", async () => {
    const realGit = _compactFactsDeps.git;
    _compactFactsDeps.git = async (args, workdir) => (args[0] === "log" ? GIT_REFUSAL : realGit(args, workdir));

    const facts = await readMemoryCompactFacts(root);

    expect(facts.commits).toEqual([]);
    expect(facts.features).toEqual([FEATURE]);
  });

  // AC-11
  test("returns branches [] when the branch listing fails", async () => {
    const realGit = _compactFactsDeps.git;
    _compactFactsDeps.git = async (args, workdir) =>
      args[0] === "for-each-ref" ? GIT_REFUSAL : realGit(args, workdir);

    const facts = await readMemoryCompactFacts(root);

    expect(facts.branches).toEqual([]);
    expect(facts.commits).toEqual(["seed the repository"]);
  });

  test("returns every git list empty when git cannot be run at all", async () => {
    _compactFactsDeps.git = async () => {
      throw new Error("spawn git ENOENT");
    };

    const facts = await readMemoryCompactFacts(root);

    expect(facts.branches).toEqual([]);
    expect(facts.commits).toEqual([]);
    expect(facts.features).toEqual([FEATURE]);
  });
});

describe("readMemoryCompactFacts when a prd.json read fails", () => {
  withDepsRestore(_compactFactsDeps, ["loadPRD"]);

  test("leaves the feature out through the loadPRD seam, keeping the git facts", async () => {
    _compactFactsDeps.loadPRD = async () => {
      throw new Error("EACCES: permission denied");
    };

    const facts = await readMemoryCompactFacts(root);

    expect(facts.features).toEqual([]);
    expect(facts.commits).toEqual(["seed the repository"]);
  });
});
