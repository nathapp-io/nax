/**
 * US-001 — placeholder candidate paths, the placeholder shape and identity, and
 * the two `/proc` parsers (src/sandbox/placeholder-paths.ts).
 *
 * Every case runs against real files in a real temp cwd: srt creates a bwrap
 * mount placeholder only where a deny path is ABSENT and its deepest existing
 * ancestor is inside a write root, so the mapping from a deny path to "the path
 * a placeholder would appear at" is exactly what these tests pin.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DANGEROUS_FILES, getDangerousDirectories } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { realOrRaw } from "#src/internal/realpath";
import { SRT_MANDATORY_DENY_DIRS, SRT_MANDATORY_DENY_FILES } from "#src/sandbox/defaults";
import type { SandboxPolicy } from "#src/sandbox/index";
import {
  candidatePaths,
  isPlaceholderShaped,
  parseMountPoints,
  parseStartTicks,
  placeholderIdentity,
} from "#src/sandbox/placeholder-paths";
import { assertDefined, cleanupTempDir, makeTempDir } from "#test/helpers/index";

let base: string;
let cwd: string;

beforeEach(() => {
  base = realOrRaw(makeTempDir("nax-placeholder-"));
  cwd = join(base, "repo");
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => cleanupTempDir(base));

/** The fixture policy the brief names: an empty cwd, the cwd as the only write root, no denies. */
function policy(over: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return { writeRoots: [cwd], denyWrite: [], denyRead: [], network: {}, ...over };
}

/** bwrap's leaf placeholder: an empty regular file, mode 0444, one link. */
function placeholderFile(path: string): void {
  writeFileSync(path, "");
  chmodSync(path, 0o444);
}

describe("candidatePaths", () => {
  test("US-001 AC1: returns the mandatory deny files then the dangerous directories", () => {
    expect(candidatePaths(cwd, policy())).toEqual([
      ...SRT_MANDATORY_DENY_FILES.map((name) => join(cwd, name)),
      join(cwd, ".vscode"),
      join(cwd, ".idea"),
      join(cwd, ".claude"),
    ]);
  });

  test("US-001 AC2: lists .claude once although two mandatory directories map to it", () => {
    const paths = candidatePaths(cwd, policy());

    expect(paths.filter((path) => path === join(cwd, ".claude"))).toEqual([join(cwd, ".claude")]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("US-001 AC3: omits a mandatory name that is already on disk", () => {
    writeFileSync(join(cwd, ".bashrc"), "# the user's own\n");

    const paths = candidatePaths(cwd, policy());

    expect(paths).not.toContain(join(cwd, ".bashrc"));
    // The neighbours are unaffected: only the existing path is dropped.
    expect(paths).toContain(join(cwd, ".profile"));
    expect(paths).toContain(join(cwd, ".zshrc"));
  });

  test("US-001 AC4: returns nothing when no write root contains the cwd", () => {
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);

    expect(candidatePaths(cwd, policy({ writeRoots: [elsewhere] }))).toEqual([]);
  });

  test("US-001 AC5: adds .git/hooks and .git/config for a .git directory", () => {
    mkdirSync(join(cwd, ".git"));

    const paths = candidatePaths(cwd, policy());

    expect(paths).toContain(join(cwd, ".git", "hooks"));
    expect(paths).toContain(join(cwd, ".git", "config"));
  });

  test("US-001 AC6: adds no .git candidate when .git is a file", () => {
    writeFileSync(join(cwd, ".git"), "gitdir: /elsewhere/repo/.git/worktrees/wt\n");

    const paths = candidatePaths(cwd, policy());

    expect(paths).not.toContain(join(cwd, ".git", "hooks"));
    expect(paths).not.toContain(join(cwd, ".git", "config"));
  });

  test("US-001 AC7: maps an absent denyWrite path to its first missing component", () => {
    const paths = candidatePaths(
      cwd,
      policy({ denyWrite: [join(cwd, ".claude", "settings.json"), join(cwd, ".zed", "settings.json")] }),
    );

    expect(paths).toContain(join(cwd, ".claude"));
    expect(paths).toContain(join(cwd, ".zed"));
    expect(paths).not.toContain(join(cwd, ".claude", "settings.json"));
    expect(paths).not.toContain(join(cwd, ".zed", "settings.json"));
  });

  test("US-001 AC8: an existing parent keeps the denyWrite path's own component", () => {
    mkdirSync(join(cwd, ".claude"));

    const paths = candidatePaths(cwd, policy({ denyWrite: [join(cwd, ".claude", "settings.json")] }));

    expect(paths).toContain(join(cwd, ".claude", "settings.json"));
  });
});

describe("isPlaceholderShaped", () => {
  test("US-001 AC9: true for an empty 0444 file and for an empty directory", () => {
    const file = join(cwd, ".bashrc");
    const dir = join(cwd, ".claude");
    placeholderFile(file);
    mkdirSync(dir);

    expect(isPlaceholderShaped(file)).toBe(true);
    expect(isPlaceholderShaped(dir)).toBe(true);
  });

  test("US-001 AC10: false for an empty 0644 file", () => {
    const path = join(cwd, ".profile");
    writeFileSync(path, "");
    chmodSync(path, 0o644);

    expect(isPlaceholderShaped(path)).toBe(false);
  });

  test("US-001 AC10: false for a 0444 file holding one byte", () => {
    const path = join(cwd, ".zshrc");
    writeFileSync(path, "x");
    chmodSync(path, 0o444);

    expect(isPlaceholderShaped(path)).toBe(false);
  });

  test("US-001 AC10: false for a 0444 empty file with a second hard link", () => {
    const path = join(cwd, ".mcp.json");
    placeholderFile(path);
    linkSync(path, join(cwd, ".mcp.json.link"));

    expect(isPlaceholderShaped(path)).toBe(false);
  });

  test("US-001 AC10: false for a symlink to a 0444 empty file", () => {
    const target = join(cwd, "target");
    const link = join(cwd, ".gitconfig");
    placeholderFile(target);
    symlinkSync(target, link);

    expect(isPlaceholderShaped(link)).toBe(false);
    // The target itself still is a placeholder; only the link is not.
    expect(isPlaceholderShaped(target)).toBe(true);
  });

  test("US-001 AC10: false for a directory holding one entry", () => {
    const dir = join(cwd, ".vscode");
    mkdirSync(dir);
    writeFileSync(join(dir, "settings.json"), "{}");

    expect(isPlaceholderShaped(dir)).toBe(false);
  });

  test("false for a path that does not exist", () => {
    expect(isPlaceholderShaped(join(cwd, "absent"))).toBe(false);
  });
});

describe("placeholderIdentity", () => {
  test("US-001 AC11: an empty 0444 file identifies as its own kind, dev and ino", () => {
    const path = join(cwd, ".bash_profile");
    placeholderFile(path);

    const identity = placeholderIdentity(path);
    assertDefined(identity, "placeholder identity");
    const stats = lstatSync(path);

    expect(identity).toEqual({ kind: "file", dev: stats.dev, ino: stats.ino });
  });

  test("US-001 AC11: undefined for an empty 0644 file", () => {
    const path = join(cwd, ".ripgreprc");
    writeFileSync(path, "");
    chmodSync(path, 0o644);

    expect(placeholderIdentity(path)).toBeUndefined();
  });

  test("an empty directory identifies as kind dir with its own dev and ino", () => {
    const path = join(cwd, ".idea");
    mkdirSync(path);

    const identity = placeholderIdentity(path);
    assertDefined(identity, "placeholder identity");
    const stats = lstatSync(path);

    expect(identity).toEqual({ kind: "dir", dev: stats.dev, ino: stats.ino });
  });
});

describe("parseStartTicks", () => {
  test("US-001 AC12: reads field 22 counting from after the last ')'", () => {
    expect(parseStartTicks("4242 (a) b (c) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 19")).toBe(777);
  });

  test("US-001 AC13: throws for a line with no ')'", () => {
    expect(() => parseStartTicks("4242 no-command-name S 1 2 3")).toThrow();
  });

  test("throws for a line with too few fields", () => {
    expect(() => parseStartTicks("4242 (cmd) S 1 2")).toThrow();
  });
});

describe("parseMountPoints", () => {
  test("US-001 AC14: returns field 5 of every line, decoding \\040", () => {
    const mountinfo = [
      "36 35 98:0 / / rw,relatime shared:1 - ext4 /dev/root rw",
      "37 36 98:1 / /home/u/my\\040repo/.zprofile rw,relatime shared:2 - ext4 /dev/root rw",
    ].join("\n");

    expect(parseMountPoints(mountinfo)).toEqual(["/", "/home/u/my repo/.zprofile"]);
  });

  test("US-001 AC15: decodes \\134 to a backslash and \\011 to a tab", () => {
    const mountinfo = "40 36 98:2 / /home/u/a\\134b\\011c rw,relatime shared:3 - ext4 /dev/root rw";

    expect(parseMountPoints(mountinfo)).toEqual(["/home/u/a\\b\tc"]);
  });

  test("skips blank lines", () => {
    const mountinfo = ["", "36 35 98:0 / / rw - ext4 /dev/root rw", "   "].join("\n");

    expect(parseMountPoints(mountinfo)).toEqual(["/"]);
  });
});

describe("the mirrored srt constants", () => {
  test("US-001 AC16: SRT_MANDATORY_DENY_FILES equals srt 0.0.77's DANGEROUS_FILES", () => {
    expect([...SRT_MANDATORY_DENY_FILES]).toEqual([...DANGEROUS_FILES]);
  });

  test("US-001 AC17: SRT_MANDATORY_DENY_DIRS equals srt 0.0.77's getDangerousDirectories()", () => {
    expect([...SRT_MANDATORY_DENY_DIRS]).toEqual(getDangerousDirectories());
  });
});
