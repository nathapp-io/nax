import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import * as chat from "@/chat";
import { expandChatMentions, formatMentionMessage, parseMentionMessage } from "@/chat";

const REPO = "/repo";
const NOT_IGNORED: GitResult = { stdout: "", exitCode: 1, timedOut: false };

interface GitResult {
  readonly stdout: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

type GitFake = (args: string[], cwd: string) => Promise<GitResult>;

/** A fake filesystem: `candidates` is what `realpath` can resolve, `contents` what can be read. */
interface FakeRepo {
  readonly candidates: Map<string, string>;
  readonly contents: Map<string, string>;
  readonly sizes: Map<string, number>;
}

const originalDeps = { ...chat._mentionExpandDeps };
let repo: FakeRepo;
let gitCalls: { args: string[]; cwd: string }[];
let gitFake: GitFake;

/** Register a path that exists: `candidate` is what the user's path resolves to, `realPath` what it really is. */
function addFile(candidate: string, realPath: string, text: string): void {
  repo.candidates.set(candidate, realPath);
  repo.contents.set(realPath, text);
  repo.sizes.set(realPath, new TextEncoder().encode(text).length);
}

function expand(text: string): Promise<{ message: string; records: readonly chat.MentionRecord[] }> {
  return expandChatMentions(text, { cwd: REPO, repoRoot: REPO });
}

function notesOf(records: readonly chat.MentionRecord[]): string[] {
  return records.map((record) => record.note);
}

beforeEach(() => {
  repo = { candidates: new Map(), contents: new Map(), sizes: new Map() };
  repo.candidates.set(REPO, REPO);
  gitCalls = [];
  gitFake = async () => NOT_IGNORED;
  chat._mentionExpandDeps.realpath = async (path) => {
    const real = repo.candidates.get(path);
    if (real === undefined) throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    return real;
  };
  chat._mentionExpandDeps.stat = async (path) => {
    const size = repo.sizes.get(path);
    if (size === undefined) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    return { isDirectory: false, size };
  };
  chat._mentionExpandDeps.readBytes = async (path) => {
    const text = repo.contents.get(path);
    if (text === undefined) throw new Error(`ENOENT: no such file, '${path}'`);
    return new TextEncoder().encode(text);
  };
  chat._mentionExpandDeps.git = async (args, cwd) => {
    gitCalls.push({ args, cwd });
    return gitFake(args, cwd);
  };
});

afterEach(() => {
  Object.assign(chat._mentionExpandDeps, originalDeps);
});

describe("expandChatMentions — whole files", () => {
  test("AC-1 attaches a text file with its line count", async () => {
    addFile("/repo/src/a.ts", "/repo/src/a.ts", "x\ny\n");
    const result = await expand("see @src/a.ts");
    expect(result.records).toEqual([{ path: "src/a.ts", status: "attached", note: "2 lines", body: "x\ny\n" }]);
  });

  test("AC-2 builds the message with formatMentionMessage", async () => {
    addFile("/repo/src/a.ts", "/repo/src/a.ts", "x\ny\n");
    const result = await expand("see @src/a.ts");
    expect(result.message).toBe(formatMentionMessage("see @src/a.ts", result.records));
  });

  test("AC-3 the message parses back to the typed text and the records", async () => {
    addFile("/repo/src/a.ts", "/repo/src/a.ts", "x\ny\n");
    const result = await expand("see @src/a.ts");
    expect(parseMentionMessage(result.message)).toEqual({ text: "see @src/a.ts", records: result.records });
  });

  test("attaches an empty file with 0 lines and an empty body", async () => {
    addFile("/repo/empty.ts", "/repo/empty.ts", "");
    const result = await expand("see @empty.ts");
    expect(result.records).toEqual([{ path: "empty.ts", status: "attached", note: "0 lines", body: "" }]);
  });

  test("counts a final line with no trailing newline", async () => {
    addFile("/repo/one.ts", "/repo/one.ts", "x");
    const result = await expand("see @one.ts");
    expect(result.records).toEqual([{ path: "one.ts", status: "attached", note: "1 lines", body: "x" }]);
  });
});

describe("expandChatMentions — locating", () => {
  test("AC-4 a path that does not exist stays plain text", async () => {
    const result = await expand("see @missing.ts");
    expect(result).toEqual({ message: "see @missing.ts", records: [] });
  });

  test("AC-5 retries an unquoted path once without trailing punctuation", async () => {
    addFile("/repo/src/a.ts", "/repo/src/a.ts", "x\n");
    const result = await expand("look at @src/a.ts.");
    expect(result.records.map((record) => record.path)).toEqual(["src/a.ts"]);
  });

  test("strips a run of trailing punctuation", async () => {
    addFile("/repo/src/a.ts", "/repo/src/a.ts", "x\n");
    const result = await expand("is it @src/a.ts?)");
    expect(result.records.map((record) => record.path)).toEqual(["src/a.ts"]);
  });

  test("does not retry a quoted path, which has no trailing punctuation to strip", async () => {
    addFile("/repo/src/a.ts", "/repo/src/a.ts", "x\n");
    const result = await expand('look at @"src/a.ts."');
    expect(result.records).toEqual([]);
  });

  test("AC-6 records one mention when two typed paths resolve to the same file", async () => {
    addFile("/repo/src/a.ts", "/repo/src/a.ts", "x\n");
    const result = await expand("@src/a.ts and @./src/a.ts");
    expect(result.records).toHaveLength(1);
  });

  test("dedups on the real path, not the typed path", async () => {
    addFile("/repo/src/a.ts", "/repo/src/a.ts", "x\n");
    addFile("/repo/alias/a.ts", "/repo/src/a.ts", "x\n");
    const result = await expand("@src/a.ts and @alias/a.ts");
    expect(result.records.map((record) => record.path)).toEqual(["src/a.ts"]);
  });
});

describe("expandChatMentions — repo boundary", () => {
  test("AC-7 refuses a path outside the repo", async () => {
    addFile("/outside.ts", "/outside.ts", "x\n");
    const result = await expand("@../outside.ts");
    expect(result.records).toEqual([
      { path: "../outside.ts", status: "refused", note: "not attached: outside the repo", body: "" },
    ]);
  });

  test("AC-8 refuses a symlink that escapes the repo", async () => {
    addFile("/repo/link.ts", "/etc/hosts", "x\n");
    const result = await expand("@link.ts");
    expect(result.records).toEqual([
      { path: "link.ts", status: "refused", note: "not attached: outside the repo", body: "" },
    ]);
  });

  test("AC-9 refuses a sibling directory whose name only starts with the repo root", async () => {
    addFile("/repo-other/x.ts", "/repo-other/x.ts", "x\n");
    const result = await expand("@../repo-other/x.ts");
    expect(notesOf(result.records)).toEqual(["not attached: outside the repo"]);
  });

  test("AC-10 refuses a path inside .git", async () => {
    addFile("/repo/.git/config", "/repo/.git/config", "x\n");
    const result = await expand("@.git/config");
    expect(result.records).toEqual([
      { path: ".git/config", status: "refused", note: "not attached: inside .git", body: "" },
    ]);
  });

  test("AC-11 refuses .git case-insensitively", async () => {
    addFile("/repo/.GIT/config", "/repo/.GIT/config", "x\n");
    const result = await expand("@.GIT/config");
    expect(notesOf(result.records)).toEqual(["not attached: inside .git"]);
  });

  test("does not consult git for a path outside the repo", async () => {
    addFile("/outside.ts", "/outside.ts", "x\n");
    await expand("@../outside.ts");
    expect(gitCalls).toEqual([]);
  });
});

describe("expandChatMentions — git-ignored paths", () => {
  test("AC-12 refuses a path git ignores", async () => {
    addFile("/repo/dist/out.js", "/repo/dist/out.js", "x\n");
    gitFake = async () => ({ stdout: "", exitCode: 0, timedOut: false });
    const result = await expand("@dist/out.js");
    expect(result.records).toEqual([
      { path: "dist/out.js", status: "refused", note: "not attached: ignored by git", body: "" },
    ]);
  });

  test("AC-13 asks git for the ignore verdict, in the cwd, about the path as typed", async () => {
    addFile("/repo/dist/out.js", "/repo/dist/out.js", "x\n");
    gitFake = async () => ({ stdout: "", exitCode: 0, timedOut: false });
    await expand("@dist/out.js");
    expect(gitCalls[0]).toEqual({
      args: ["check-ignore", "-q", "--", "dist/out.js"],
      cwd: "/repo",
    });
  });

  test("AC-14 refuses a path whose check-ignore timed out", async () => {
    addFile("/repo/a.ts", "/repo/a.ts", "x\n");
    gitFake = async () => ({ stdout: "", exitCode: 1, timedOut: true });
    const result = await expand("@a.ts");
    expect(notesOf(result.records)).toEqual(["not attached: git timed out"]);
  });

  test("AC-15 refuses a path when check-ignore fails", async () => {
    addFile("/repo/a.ts", "/repo/a.ts", "x\n");
    gitFake = async () => ({ stdout: "", exitCode: 128, timedOut: false });
    const result = await expand("@a.ts");
    expect(notesOf(result.records)).toEqual(["not attached: git check-ignore failed (exit 128)"]);
  });
});

describe("expandChatMentions — failure isolation", () => {
  test("AC-16 one failing token does not stop the next", async () => {
    addFile("/repo/a.ts", "/repo/a.ts", "x\n");
    addFile("/repo/b.ts", "/repo/b.ts", "y\n");
    gitFake = async (args) => {
      if (args[args.length - 1] === "a.ts") throw new Error("spawn failed");
      return NOT_IGNORED;
    };
    const result = await expand("@a.ts @b.ts");
    expect(result.records.map((record) => [record.status, record.note])).toEqual([
      ["refused", "not attached: spawn failed"],
      ["attached", "1 lines"],
    ]);
  });

  test("records a refused entry when the file cannot be read", async () => {
    addFile("/repo/a.ts", "/repo/a.ts", "x\n");
    repo.contents.delete("/repo/a.ts");
    const result = await expand("@a.ts");
    expect(result.records).toEqual([
      { path: "a.ts", status: "refused", note: "not attached: ENOENT: no such file, '/repo/a.ts'", body: "" },
    ]);
  });
});

describe("_mentionExpandDeps", () => {
  test("the default filesystem deps read a real file", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "src"));
      await Bun.write(join(root, "src/a.ts"), "x\ny\n");
      Object.assign(chat._mentionExpandDeps, originalDeps);
      chat._mentionExpandDeps.git = async () => NOT_IGNORED;
      const result = await expandChatMentions("see @src/a.ts", { cwd: root, repoRoot: root });
      expect(result.records).toEqual([{ path: "src/a.ts", status: "attached", note: "2 lines", body: "x\ny\n" }]);
    });
  });

  test("the default stat and readdir deps describe entries on disk", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "sub"));
      await Bun.write(join(root, "a.ts"), "x");
      expect(await originalDeps.stat(join(root, "sub"))).toEqual({ isDirectory: true, size: expect.any(Number) });
      expect(await originalDeps.stat(join(root, "a.ts"))).toEqual({ isDirectory: false, size: 1 });
      const entries = await originalDeps.readdir(root);
      expect(entries).toHaveLength(2);
      expect(entries).toContainEqual({ name: "a.ts", isDirectory: false });
      expect(entries).toContainEqual({ name: "sub", isDirectory: true });
    });
  });
});

/**
 * F1: the check-ignore invocation must be one real git actually answers. The fake-git tests
 * above cannot see a pathspec option git rejects outright, so this one runs the shipped
 * commands against a real checkout.
 */
describe("check-ignore against real git", () => {
  test("answers ignored / not-ignored instead of failing with a fatal pathspec error", async () => {
    await withTempDir(async (root) => {
      // An empty template dir: a sandboxed agent cannot read the system template directory,
      // and the fixture needs none of it.
      const init = await originalDeps.git(["-c", "init.templateDir=", "init", "-q"], root);
      expect(init.exitCode).toBe(0);
      await Bun.write(join(root, ".gitignore"), "dist/\n");
      await mkdir(join(root, "dist"));
      await Bun.write(join(root, "dist/out.js"), "x\n");
      await Bun.write(join(root, "a.ts"), "x\n");
      Object.assign(chat._mentionExpandDeps, originalDeps);
      const result = await expandChatMentions("see @dist/out.js and @a.ts", { cwd: root, repoRoot: root });
      expect(result.records.map((record) => [record.path, record.status, record.note])).toEqual([
        ["dist/out.js", "refused", "not attached: ignored by git"],
        ["a.ts", "attached", "1 lines"],
      ]);
    });
  });
});
