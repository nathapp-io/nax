import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { botGit } from "@/bot/git";
import { pinBaseForSession } from "@/bot/session-pin";

let repo: string;
let base: string;
async function git(args: string[]): Promise<string> {
  const result = await botGit(args, repo);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
const read = (path: string) => Bun.file(join(repo, path)).text();
const exists = (path: string) => Bun.file(join(repo, path)).exists();
beforeEach(async () => {
  repo = makeTempDir("session-pin-");
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.com"]);
  await Bun.write(join(repo, "CLAUDE.md"), "base");
  await Bun.write(join(repo, ".mcp.json"), "base-mcp");
  await Bun.write(join(repo, "src/a.ts"), "base");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  base = await git(["rev-parse", "HEAD"]);
  await Bun.write(join(repo, "CLAUDE.md"), "head");
  await Bun.write(join(repo, ".claude/settings.json"), "head-settings");
  await git(["rm", ".mcp.json"]);
  await git(["add", "."]);
  await git(["commit", "-m", "head"]);
});
afterEach(() => cleanupTempDir(repo));

describe("pinBaseForSession", () => {
  test("AC-1 through AC-6 pins base content without index or status changes", async () => {
    const pin = await pinBaseForSession(repo, base);
    expect(await read("CLAUDE.md")).toBe("base");
    expect(await git(["status", "--porcelain"])).not.toContain("CLAUDE.md");
    expect(await git(["diff", "--cached", "--name-only"])).toBe("");
    expect(await exists(".claude/settings.json")).toBe(false);
    expect(await read(".mcp.json")).toBe("base-mcp");
    expect(await git(["status", "--porcelain"])).not.toContain(".mcp.json");
    expect([...pin.paths].sort()).toEqual([".claude/settings.json", ".mcp.json", "CLAUDE.md"]);
  });
  test("AC-7 and AC-8 add-all commits only source and preserves HEAD config", async () => {
    await pinBaseForSession(repo, base);
    await Bun.write(join(repo, "src/a.ts"), "changed");
    await git(["add", "-A"]);
    await git(["commit", "-m", "x"]);
    expect(await git(["show", "--format=", "--name-only", "HEAD"])).toBe("src/a.ts");
    expect(await git(["show", "HEAD:CLAUDE.md"])).toBe("head");
  });
  test("AC-9 through AC-12 restores head files and clean status", async () => {
    const pin = await pinBaseForSession(repo, base);
    await pin.restore();
    expect(await read("CLAUDE.md")).toBe("head");
    expect(await read(".claude/settings.json")).toBe("head-settings");
    expect(await exists(".mcp.json")).toBe(false);
    expect(await git(["status", "--porcelain"])).toBe("");
  });
  test("commit -a excludes pinned config and restore discards uncommitted config edits", async () => {
    const pin = await pinBaseForSession(repo, base);
    await Bun.write(join(repo, "CLAUDE.md"), "uncommitted agent edit");
    await Bun.write(join(repo, "src/a.ts"), "changed");
    await git(["commit", "-am", "x"]);
    expect(await git(["show", "--format=", "--name-only", "HEAD"])).toBe("src/a.ts");
    await pin.restore();
    expect(await read("CLAUDE.md")).toBe("head");
    expect(await git(["status", "--porcelain"])).toBe("");
  });
  test("literal glob and newline paths survive pin and restore", async () => {
    const path = ".claude/[a]*\nconfig.json";
    await Bun.write(join(repo, path), "literal-base");
    await git(["add", "."]);
    await git(["commit", "-m", "literal base"]);
    const literalBase = await git(["rev-parse", "HEAD"]);
    await git(["rm", "--", `:(literal)${path}`]);
    await git(["commit", "-m", "literal head"]);
    const pin = await pinBaseForSession(repo, literalBase);
    expect(await read(path)).toBe("literal-base");
    expect(await git(["status", "--porcelain"])).toBe("");
    await pin.restore();
    expect(await exists(path)).toBe(false);
    expect(await git(["status", "--porcelain"])).toBe("");
  });
  test("AC-13 restores current HEAD, not the original head", async () => {
    const pin = await pinBaseForSession(repo, base);
    await Bun.write(join(repo, "CLAUDE.md"), "agent");
    await git(["update-index", "--no-skip-worktree", "CLAUDE.md"]);
    await git(["add", "CLAUDE.md"]);
    await git(["commit", "-m", "x"]);
    await pin.restore();
    expect(await read("CLAUDE.md")).toBe("agent");
    expect(await git(["status", "--porcelain"])).toBe("");
  });
});
