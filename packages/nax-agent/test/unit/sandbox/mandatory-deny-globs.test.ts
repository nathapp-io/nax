/**
 * #3038 (darwin): srt's seatbelt profile anchors its nested mandatory denies
 * (`**\/<file>`, `**\/<dir>/**`, `**\/.git/hooks/**`, `**\/.git/config`) at the
 * process cwd. `rootMandatoryDenyGlobs` names the same set beneath the session
 * root, as patterns srt compiles for a per-command denyWrite.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { macGetMandatoryDenyEntries } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { denyGlobRegex } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { realOrRaw } from "#src/internal/realpath";
import { rootMandatoryDenyGlobs } from "#src/sandbox/mandatory-deny-globs";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

let base: string;
let root: string;
beforeEach(() => {
  base = realOrRaw(makeTempDir("nax-deny-globs-"));
  root = join(base, "root");
  mkdirSync(root);
});
afterEach(() => cleanupTempDir(base));

/** The regex srt compiles for a per-command denyWrite glob (its toPathEntry -> denyGlobRegex path). */
function ourRegexes(globs: readonly string[]): RegExp[] {
  return globs.map((g) => new RegExp(denyGlobRegex(g)));
}

function matches(regexes: readonly RegExp[], path: string): boolean {
  return regexes.some((r) => r.test(path));
}

describe("rootMandatoryDenyGlobs", () => {
  test("covers every file name, directory name and the two .git paths beneath the root", () => {
    const globs = rootMandatoryDenyGlobs(root);
    expect(globs).toContain(`${root}/**/.mcp.json`);
    expect(globs).toContain(`${root}/**/.bashrc`);
    expect(globs).toContain(`${root}/**/.vscode/?*`);
    expect(globs).toContain(`${root}/**/.claude/commands/?*`);
    expect(globs).toContain(`${root}/**/.git/hooks/?*`);
    expect(globs).toContain(`${root}/**/.git/config`);
    // 9 files + 4 directories + .git/hooks + .git/config
    expect(globs).toHaveLength(15);
  });

  test("no entry ends in /** (srt strips that suffix, which would also deny the bare directory)", () => {
    for (const g of rootMandatoryDenyGlobs(root)) expect(g.endsWith("/**")).toBe(false);
  });

  test("matches exactly what srt's own cwd-anchored entries match, for cwd == root", () => {
    const previous = process.cwd();
    process.chdir(root);
    let entries: ReadonlyArray<{ glob: boolean; path: string; anchor?: string }>;
    try {
      entries = macGetMandatoryDenyEntries(false);
    } finally {
      process.chdir(previous);
    }
    const escape = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const srt = entries.map((e) =>
      e.glob
        ? new RegExp(`^${escape(e.anchor ?? "")}${denyGlobRegex(e.path.slice((e.anchor ?? "").length)).slice(1)}`)
        : new RegExp(`^${escape(e.path)}(/.*)?$`),
    );
    const ours = ourRegexes(rootMandatoryDenyGlobs(root));
    const samples = [
      "sub/.mcp.json",
      "a/b/.bashrc",
      "sub/.vscode",
      "sub/.vscode/tasks.json",
      "sub/.vscode/a/b.json",
      "sub/.idea/x",
      "sub/.claude/commands",
      "sub/.claude/commands/e.md",
      "sub/.claude/agents/a.md",
      "sub/.claude/settings.json",
      "nested/.git/hooks",
      "nested/.git/hooks/pre-commit",
      "nested/.git/config",
      "nested/.git/info/exclude",
      "sub/readme.md",
      "sub/.mcp.json.bak",
      "sub/x.vscode/tasks.json",
    ].map((rel) => join(root, rel));
    for (const path of samples) {
      const theirs = matches(srt, path);
      const mine = matches(ours, path);
      // Includes a bare nested directory name: srt leaves it creatable (only its CHILDREN are
      // denied), which is why the directory patterns end in `/?*` and not `/**`.
      expect({ path, mine }).toEqual({ path, mine: theirs });
    }
  });

  test("a root whose name holds regex metacharacters matches only itself", () => {
    const odd = join(base, "a.b+(c)$d{e}");
    mkdirSync(odd);
    const ours = ourRegexes(rootMandatoryDenyGlobs(odd));
    expect(matches(ours, join(odd, "sub", ".mcp.json"))).toBe(true);
    expect(matches(ours, join(base, "aXb+(c)$d{e}", "sub", ".mcp.json"))).toBe(false);
    expect(matches(ours, join(base, "a.b+(c)$d{e}2", "sub", ".mcp.json"))).toBe(false);
  });

  test.each(["[", "]", "*", "?"])("a root holding %p is refused, never compiled into a pattern", (ch) => {
    expect(() => rootMandatoryDenyGlobs(join(base, `a${ch}b`))).toThrow(/glob character/);
  });
});
