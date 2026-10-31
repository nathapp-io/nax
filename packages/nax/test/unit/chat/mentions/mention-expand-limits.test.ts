/**
 * The content steps of the mention expander: the folder listing (step 5), the read-size guard
 * (6), the binary probe (7), the per-file cut (8), the message total cap (9), and the read
 * failure that becomes a `refused` record.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import * as chat from "@/chat";
import {
  expandChatMentions,
  MENTION_BINARY_PROBE_BYTES,
  MENTION_FILE_MAX_CHARS,
  MENTION_READ_MAX_BYTES,
  type MentionRecord,
} from "@/chat";

const REPO = "/repo";
const NOT_IGNORED: GitResult = { stdout: "", exitCode: 1, timedOut: false };
const ENCODER = new TextEncoder();

interface GitResult {
  readonly stdout: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

type GitFake = (args: string[], cwd: string) => Promise<GitResult>;

const originalDeps = { ...chat._mentionExpandDeps };

let realPaths: Map<string, string>;
let stats: Map<string, { isDirectory: boolean; size: number }>;
let contents: Map<string, Uint8Array>;
let listings: Map<string, readonly DirEntry[]>;
let readErrors: Map<string, Error>;
let readCalls: string[];
let gitCalls: { args: string[]; cwd: string }[];
let gitFake: GitFake;

/** Register a text file at `path` in the fake repo. */
function addText(path: string, text: string): void {
  addBytes(path, ENCODER.encode(text));
}

function addBytes(path: string, bytes: Uint8Array): void {
  realPaths.set(path, path);
  stats.set(path, { isDirectory: false, size: bytes.length });
  contents.set(path, bytes);
}

/** A file whose `stat` succeeds but whose `readBytes` rejects. */
function addUnreadable(path: string, message: string): void {
  realPaths.set(path, path);
  stats.set(path, { isDirectory: false, size: 1 });
  readErrors.set(path, new Error(message));
}

/** A file too large to read: `stat` reports its size, and there are no bytes to hand back. */
function addOversize(path: string, size: number): void {
  realPaths.set(path, path);
  stats.set(path, { isDirectory: false, size });
}

function addFolder(path: string, entries: readonly DirEntry[] = []): void {
  realPaths.set(path, path);
  stats.set(path, { isDirectory: true, size: 0 });
  listings.set(path, entries);
}

/** A fake git that answers every `ls-files` call with `stdout` and answers nothing else. */
function lsFiles(stdout: string, exitCode = 0): GitFake {
  return async (args) => (args[0] === "--literal-pathspecs" ? { stdout, exitCode, timedOut: false } : NOT_IGNORED);
}

/** NUL-delimited `ls-files -z` output for the given paths. */
function listed(paths: readonly string[]): GitFake {
  return lsFiles(paths.map((path) => `${path}\0`).join(""));
}

function expand(text: string): Promise<{ message: string; records: readonly MentionRecord[] }> {
  return expandChatMentions(text, { cwd: REPO, repoRoot: REPO });
}

/** A text file of `lines` lines, each 9 characters plus its newline, so 10 characters a line. */
function repeatedLines(lines: number): string {
  return "abcdefghi\n".repeat(lines);
}

beforeEach(() => {
  realPaths = new Map([[REPO, REPO]]);
  stats = new Map();
  contents = new Map();
  listings = new Map();
  readErrors = new Map();
  readCalls = [];
  gitCalls = [];
  gitFake = async () => NOT_IGNORED;
  chat._mentionExpandDeps.realpath = async (path) => {
    const real = realPaths.get(path);
    if (real === undefined) throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    return real;
  };
  chat._mentionExpandDeps.stat = async (path) => {
    const info = stats.get(path);
    if (info === undefined) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    return info;
  };
  chat._mentionExpandDeps.readBytes = async (path) => {
    readCalls.push(path);
    const failure = readErrors.get(path);
    if (failure !== undefined) throw failure;
    const bytes = contents.get(path);
    if (bytes === undefined) throw new Error(`ENOENT: no such file, '${path}'`);
    return bytes;
  };
  chat._mentionExpandDeps.readdir = async (path) => {
    const entries = listings.get(path);
    if (entries === undefined) throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    return entries;
  };
  chat._mentionExpandDeps.git = async (args, cwd) => {
    gitCalls.push({ args, cwd });
    return gitFake(args, cwd);
  };
});

afterEach(() => {
  Object.assign(chat._mentionExpandDeps, originalDeps);
});

describe("expandChatMentions — folder listings", () => {
  test("AC-1 lists direct entries once each, subfolders with a trailing slash", async () => {
    addFolder("/repo/src");
    gitFake = listed(["src/a.ts", "src/b/c.ts", "src/b/d.ts"]);
    const result = await expand("@src/");
    expect(result.records).toEqual([{ path: "src/", status: "folder", note: "2 entries", body: "a.ts\nb/" }]);
  });

  test("AC-2 asks git with literal pathspecs for the normalised folder, in the cwd", async () => {
    addFolder("/repo/src");
    gitFake = listed(["src/a.ts"]);
    await expand("@src/");
    const lsFilesCall = gitCalls.find((call) => call.args[0] === "--literal-pathspecs");
    expect(lsFilesCall).toEqual({
      args: ["--literal-pathspecs", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src/"],
      cwd: REPO,
    });
  });

  test("AC-3 normalises a folder named without a trailing slash", async () => {
    addFolder("/repo/src");
    gitFake = listed(["src/a.ts", "src/b/c.ts", "src/b/d.ts"]);
    const result = await expand("@src");
    expect(result.records.map((record) => record.body)).toEqual(["a.ts\nb/"]);
  });

  test("AC-4 falls back to readdir when ls-files exits non-zero", async () => {
    addFolder("/repo/src", [
      { name: "b", isDirectory: true },
      { name: "a.ts", isDirectory: false },
    ]);
    gitFake = lsFiles("", 1);
    const result = await expand("@src/");
    expect(result.records.map((record) => record.body)).toEqual(["a.ts\nb/"]);
  });

  test("lists the cwd itself under the `.` pathspec, taking each first segment", async () => {
    addFolder(REPO, [
      { name: "z", isDirectory: true },
      { name: "a.ts", isDirectory: false },
    ]);
    gitFake = lsFiles("", 128);
    const result = await expand("@.");
    expect(result.records).toEqual([{ path: ".", status: "folder", note: "2 entries", body: "a.ts\nz/" }]);
    expect(gitCalls.filter((call) => call.args[0] === "--literal-pathspecs").map((call) => call.args.at(-1))).toEqual([
      ".",
    ]);
  });

  test("counts a repeated listed path once", async () => {
    addFolder("/repo/src");
    gitFake = listed(["src/a.ts", "src/a.ts", "src/a.ts"]);
    const result = await expand("@src/");
    expect(result.records.map((record) => [record.note, record.body])).toEqual([["1 entries", "a.ts"]]);
  });

  test("reports a folder with no entries as 0 entries and an empty body", async () => {
    addFolder("/repo/empty");
    gitFake = listed([]);
    const result = await expand("@empty/");
    expect(result.records).toEqual([{ path: "empty/", status: "folder", note: "0 entries", body: "" }]);
  });

  test("asks for the pathspec in the cwd's frame even when the real path is canonicalised", async () => {
    // macOS: cwd /repo is a symlink to /private/repo, so realpath reports a different frame.
    realPaths.set(REPO, "/private/repo");
    realPaths.set("/repo/src", "/private/repo/src");
    addFolder("/private/repo/src");
    gitFake = listed(["src/a.ts"]);
    const result = await expand("@src/");
    expect(result.records.map((record) => record.body)).toEqual(["a.ts"]);
    expect(gitCalls.filter((call) => call.args[0] === "--literal-pathspecs").map((call) => call.args.at(-1))).toEqual([
      "src/",
    ]);
  });
});

describe("expandChatMentions — read guards", () => {
  test("AC-5 records a file too large to read as path-only", async () => {
    addOversize("/repo/big.bin", MENTION_READ_MAX_BYTES + 1);
    const result = await expand("@big.bin");
    expect(result.records).toEqual([
      { path: "big.bin", status: "path-only", note: "path only: file too large", body: "" },
    ]);
  });

  test("AC-6 does not read the bytes of a file too large to read", async () => {
    addOversize("/repo/big.bin", MENTION_READ_MAX_BYTES + 1);
    await expand("@big.bin");
    expect(readCalls).toEqual([]);
  });

  test("reads a file exactly at the read ceiling", async () => {
    addText("/repo/at-limit.ts", "x\n");
    stats.set("/repo/at-limit.ts", { isDirectory: false, size: MENTION_READ_MAX_BYTES });
    const result = await expand("@at-limit.ts");
    expect(result.records).toEqual([{ path: "at-limit.ts", status: "attached", note: "1 lines", body: "x\n" }]);
  });

  test("AC-7 records a file with a NUL byte early on as path-only binary", async () => {
    addBytes("/repo/img.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const result = await expand("@img.png");
    expect(result.records).toEqual([{ path: "img.png", status: "path-only", note: "path only: binary", body: "" }]);
  });

  test("finds a NUL at the last probed byte", async () => {
    const bytes = new Uint8Array(MENTION_BINARY_PROBE_BYTES);
    bytes.fill(0x61);
    bytes[MENTION_BINARY_PROBE_BYTES - 1] = 0;
    addBytes("/repo/edge.bin", bytes);
    const result = await expand("@edge.bin");
    expect(result.records.map((record) => record.status)).toEqual(["path-only"]);
  });

  test("attaches a file whose only NUL sits past the probe", async () => {
    const bytes = new Uint8Array(MENTION_BINARY_PROBE_BYTES + 2);
    bytes.fill(0x61);
    bytes[MENTION_BINARY_PROBE_BYTES] = 0;
    addBytes("/repo/late.bin", bytes);
    const result = await expand("@late.bin");
    expect(result.records.map((record) => record.status)).toEqual(["attached"]);
  });
});

describe("expandChatMentions — cutting to the per-file cap", () => {
  test("AC-8 cuts a long file to whole lines and says how many of how many", async () => {
    addText("/repo/long.txt", repeatedLines(30_000));
    const result = await expand("@long.txt");
    expect(result.records.map((record) => record.note)).toEqual(["first 10000 of 30000 lines"]);
  });

  test("AC-9 keeps exactly the first MENTION_FILE_MAX_CHARS characters of that file", async () => {
    const text = repeatedLines(30_000);
    addText("/repo/long.txt", text);
    const result = await expand("@long.txt");
    expect(result.records[0]?.status).toBe("cut");
    expect(result.records[0]?.body).toBe(text.slice(0, MENTION_FILE_MAX_CHARS));
  });

  test("AC-10 cuts a single over-long line to one line", async () => {
    addText("/repo/wide.txt", "w".repeat(MENTION_FILE_MAX_CHARS + 50));
    const result = await expand("@wide.txt");
    expect(result.records.map((record) => record.note)).toEqual(["first 1 of 1 lines"]);
  });

  test("AC-11 keeps exactly MENTION_FILE_MAX_CHARS characters of that line", async () => {
    const text = "w".repeat(MENTION_FILE_MAX_CHARS + 50);
    addText("/repo/wide.txt", text);
    const result = await expand("@wide.txt");
    expect(result.records[0]?.body).toBe(text.slice(0, MENTION_FILE_MAX_CHARS));
  });

  test("keeps whole lines only, dropping a line that would overflow the cap", async () => {
    const text = "abcdef\n".repeat(20_000);
    addText("/repo/seven.txt", text);
    const result = await expand("@seven.txt");
    const wholeLines = Math.floor(MENTION_FILE_MAX_CHARS / 7);
    expect(result.records[0]?.note).toBe(`first ${wholeLines} of 20000 lines`);
    expect(result.records[0]?.body).toBe(text.slice(0, wholeLines * 7));
    expect(result.records[0]?.body.endsWith("\n")).toBe(true);
  });

  test("attaches a file exactly at the per-file cap without cutting it", async () => {
    const text = "x".repeat(MENTION_FILE_MAX_CHARS);
    addText("/repo/exact.txt", text);
    const result = await expand("@exact.txt");
    expect(result.records).toEqual([{ path: "exact.txt", status: "attached", note: "1 lines", body: text }]);
  });

  test("AC-12 attaches an empty file with 0 lines and an empty body", async () => {
    addText("/repo/empty.ts", "");
    const result = await expand("@empty.ts");
    expect(result.records).toEqual([{ path: "empty.ts", status: "attached", note: "0 lines", body: "" }]);
  });
});

describe("expandChatMentions — the message total cap", () => {
  test("AC-13 drops a fifth 90k file past the total cap", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) addText(`/repo/${name}.txt`, repeatedLines(9_000));
    const result = await expand("@a.txt @b.txt @c.txt @d.txt @e.txt");
    expect(result.records.map((record) => record.status)).toEqual([
      "attached",
      "attached",
      "attached",
      "attached",
      "path-only",
    ]);
  });

  test("AC-14 gives the over-cap record the message-too-large note and an empty body", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) addText(`/repo/${name}.txt`, repeatedLines(9_000));
    const result = await expand("@a.txt @b.txt @c.txt @d.txt @e.txt");
    expect(result.records.at(-1)).toEqual({
      path: "e.txt",
      status: "path-only",
      note: "path only: message too large",
      body: "",
    });
  });

  test("AC-15 applies the same cap to a folder listing", async () => {
    for (const name of ["a", "b", "c", "d"]) addText(`/repo/${name}.txt`, repeatedLines(9_000));
    addFolder("/repo/src");
    const names = Array.from({ length: 2_381 }, (_, index) => `f${String(index).padStart(4, "0")}-`.padEnd(20, "x"));
    gitFake = async (args) =>
      args[0] === "--literal-pathspecs"
        ? { stdout: names.map((name) => `src/${name}\0`).join(""), exitCode: 0, timedOut: false }
        : NOT_IGNORED;
    const result = await expand("@a.txt @b.txt @c.txt @d.txt @src/");
    expect(result.records.map((record) => record.status)).toEqual([
      "attached",
      "attached",
      "attached",
      "attached",
      "path-only",
    ]);
    // The listing the folder would have carried is exactly 50 000 characters: 2 381 names of
    // 20 characters separated by 2 380 newlines.
    expect(names.join("\n").length).toBe(50_000);
    expect(result.records.at(-1)?.note).toBe("path only: message too large");
  });

  test("counts only the bodies it kept, so a dropped token frees nothing for later ones", async () => {
    // 4 x 90 000 = 360 000 of the 400 000-character cap; the fifth and sixth would push past it.
    for (const name of ["a", "b", "c", "d", "e", "f"]) addText(`/repo/${name}.txt`, repeatedLines(9_000));
    const result = await expand("@a.txt @b.txt @c.txt @d.txt @e.txt @f.txt");
    expect(result.records.map((record) => record.status)).toEqual([
      "attached",
      "attached",
      "attached",
      "attached",
      "path-only",
      "path-only",
    ]);
  });
});

describe("expandChatMentions — isolated read failures", () => {
  test("AC-16 a file that cannot be read is refused while the next one attaches", async () => {
    addUnreadable("/repo/a.ts", "EACCES: permission denied");
    addText("/repo/b.ts", "y\n");
    const result = await expand("@a.ts @b.ts");
    expect(result.records.map((record) => [record.status, record.note])).toEqual([
      ["refused", "not attached: EACCES: permission denied"],
      ["attached", "1 lines"],
    ]);
  });

  test("a folder that cannot be listed is refused", async () => {
    addFolder("/repo/src");
    listings.delete("/repo/src");
    gitFake = lsFiles("", 1);
    const result = await expand("@src/");
    expect(result.records.map((record) => [record.status, record.note])).toEqual([
      ["refused", "not attached: ENOTDIR: not a directory, scandir '/repo/src'"],
    ]);
  });

  test("a stat that rejects is refused", async () => {
    realPaths.set("/repo/ghost.ts", "/repo/ghost.ts");
    const result = await expand("@ghost.ts");
    expect(result.records.map((record) => [record.status, record.note])).toEqual([
      ["refused", "not attached: ENOENT: no such file or directory, stat '/repo/ghost.ts'"],
    ]);
  });

  test("AC-17 still attaches a small whole file, the US-002 whole-file behaviour", async () => {
    addText("/repo/a.ts", "x\ny\n");
    const result = await expandChatMentions("see @a.ts", { cwd: REPO, repoRoot: REPO });
    expect(result.records).toEqual([{ path: "a.ts", status: "attached", note: "2 lines", body: "x\ny\n" }]);
  });
});

/**
 * The fake-git tests above cannot see an invocation real git rejects, so this one runs the
 * shipped `ls-files` command against a real checkout.
 */
describe("folder listing against real git", () => {
  test("lists a subfolder and the cwd itself from a real checkout", async () => {
    await withTempDir(async (root) => {
      // An empty template dir: a sandboxed agent cannot read the system template directory.
      const init = await originalDeps.git(["-c", "init.templateDir=", "init", "-q"], root);
      expect(init.exitCode).toBe(0);
      await mkdir(join(root, "src/b"), { recursive: true });
      await mkdir(join(root, "ignored"));
      await Bun.write(join(root, "src/a.ts"), "x\n");
      await Bun.write(join(root, "src/b/c.ts"), "y\n");
      await Bun.write(join(root, "top.ts"), "z\n");
      await Bun.write(join(root, ".gitignore"), "ignored/\n");
      await Bun.write(join(root, "ignored/skipped.ts"), "w\n");
      Object.assign(chat._mentionExpandDeps, originalDeps);
      const result = await expandChatMentions("see @src/ and @.", { cwd: root, repoRoot: root });
      expect(result.records).toEqual([
        { path: "src/", status: "folder", note: "2 entries", body: "a.ts\nb/" },
        { path: ".", status: "folder", note: "3 entries", body: ".gitignore\nsrc/\ntop.ts" },
      ]);
    });
  });
});
