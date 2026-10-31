import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import {
  _mentionFilesDeps,
  createMentionFileIndex,
  listMentionFiles,
  MENTION_FILE_INDEX_MAX_AGE_MS,
  type MentionFileList,
} from "@/chat";

const REPO = "/repo";
const LISTING = "src/b/c.ts\0a.ts\0";
const LS_FILES_ARGS = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];

const originalDeps = { ..._mentionFilesDeps };

/** One recorded git call, so a test can assert the listing was asked for exactly once. */
interface GitCall {
  readonly args: readonly string[];
  readonly cwd: string;
}

interface GitAnswer {
  readonly stdout: string;
  readonly exitCode: number;
}

let gitCalls: GitCall[];
let gitAnswer: (args: readonly string[], cwd: string) => Promise<GitAnswer>;
let clock: number;

function pathsOf(list: MentionFileList): string[] {
  return list.rows.map((row) => row.path);
}

beforeEach(() => {
  gitCalls = [];
  clock = 1_000;
  gitAnswer = async () => ({ stdout: LISTING, exitCode: 0 });
  _mentionFilesDeps.git = async (args, cwd) => {
    gitCalls.push({ args, cwd });
    return gitAnswer(args, cwd);
  };
  _mentionFilesDeps.now = () => clock;
});

afterEach(() => {
  Object.assign(_mentionFilesDeps, originalDeps);
});

describe("listMentionFiles", () => {
  test("AC-1 lists the repository through git ls-files and reports git", async () => {
    const list = await listMentionFiles(REPO);
    expect(list.git).toBe(true);
    expect(gitCalls).toEqual([{ args: LS_FILES_ARGS, cwd: REPO }]);
  });

  test("AC-2 adds one row per listed path and per distinct ancestor folder, sorted by path", async () => {
    const list = await listMentionFiles(REPO);
    expect(pathsOf(list)).toEqual(["a.ts", "src/", "src/b/", "src/b/c.ts"]);
  });

  test("AC-3 flags exactly the ancestor folders as folders", async () => {
    const list = await listMentionFiles(REPO);
    expect(list.rows.filter((row) => row.folder).map((row) => row.path)).toEqual(["src/", "src/b/"]);
  });

  test("AC-4 returns no list when git exits non-zero", async () => {
    gitAnswer = async () => ({ stdout: "", exitCode: 128 });
    expect(await listMentionFiles(REPO)).toEqual({ git: false, rows: [] });
  });

  test("AC-4 returns no list when the git call rejects with a spawn error", async () => {
    gitAnswer = async () => {
      throw new Error("spawn git ENOENT");
    };
    expect(await listMentionFiles(REPO)).toEqual({ git: false, rows: [] });
  });

  test("the default git dependency lists a real repository", async () => {
    Object.assign(_mentionFilesDeps, originalDeps);
    await withTempDir(async (dir) => {
      await Bun.spawn(["git", "init"], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
      await Bun.write(join(dir, "a.ts"), "");
      await Bun.write(join(dir, "src", "b.ts"), "");
      const list = await listMentionFiles(dir);
      expect(list.git).toBe(true);
      expect(pathsOf(list)).toEqual(["a.ts", "src/", "src/b.ts"]);
    });
  });
});

describe("createMentionFileIndex", () => {
  test("AC-5 reuses the last list while it is younger than the max age", async () => {
    const index = createMentionFileIndex(REPO);
    const first = await index.get();
    clock += MENTION_FILE_INDEX_MAX_AGE_MS - 1;
    const second = await index.get();
    expect(gitCalls.length).toBe(1);
    expect(second).toEqual(first);
  });

  test("AC-6 re-lists once the last list has reached the max age", async () => {
    const index = createMentionFileIndex(REPO);
    await index.get();
    clock += MENTION_FILE_INDEX_MAX_AGE_MS;
    await index.get();
    expect(gitCalls.length).toBe(2);
  });

  test("AC-7 two concurrent calls share one in-flight listing", async () => {
    const index = createMentionFileIndex(REPO);
    const [first, second] = await Promise.all([index.get(), index.get()]);
    expect(gitCalls.length).toBe(1);
    expect(second).toEqual(first);
    expect(pathsOf(second)).toEqual(["a.ts", "src/", "src/b/", "src/b/c.ts"]);
  });
});
