/**
 * US-006 branch-review B1: the Claude settings deny must hold on the NATIVE
 * tool path too, not only inside the OS sandbox and behind the ACP edit check.
 *
 * The sandbox's `denyWrite` stops a sandboxed command, and the ACP edit path
 * (`firstOutsidePolicy`) stops an ACP Write/Edit; but the native `Write`,
 * `Edit` and `Delete` tools run through `compileToolPolicy` and Node's fs APIs
 * with no sandbox around them at all. `workflowImplementOp` declares all three,
 * so an implementer could add an allow rule, a hook or an MCP server to
 * `<root>/.claude/settings.json` and weaken every later session started in that
 * workdir — the escalation US-006 exists to prevent.
 *
 * Everything below is asserted through `createCodingToolRuntime`, i.e. at the
 * caller (the tool call the model actually makes), not only at
 * `policy.check` — a policy that denies while the tool still writes is exactly
 * the defect this file exists to prevent. The settings names come from the same
 * constant the sandbox builder consumes, so the two cannot drift.
 *
 * Reads are deliberately untouched (a session legitimately reads its own
 * settings), and `.claude/` as a whole stays writable — skills, commands and
 * agents live there — so only the two settings FILES are refused.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_SETTINGS_FILES } from "#src/sandbox/claude-settings";
import type { CodingToolOutcome, CodingToolRuntime } from "#src/tools/index";
import { compileToolPolicy, createCodingToolRuntime } from "#src/tools/index";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const SETTINGS = ".claude/settings.json";
const SETTINGS_LOCAL = ".claude/settings.local.json";
const ORIGINAL = '{"permissions":{"allow":["Bash(*)"]}}';

let root: string;
let runtime: CodingToolRuntime;

beforeEach(() => {
  root = makeTempDir("nax-claude-settings-");
  runtime = createCodingToolRuntime({
    policy: compileToolPolicy(
      ["Write", "Edit", "Delete", "Read", "Glob"].map((tool) => ({ tool, patterns: ["*"] })),
      root,
    ),
  });
});

afterEach(() => {
  cleanupTempDir(root);
});

/** Write the two settings files, so an allowed mutation would be observable on disk. */
function seedSettings(): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  for (const rel of [SETTINGS, SETTINGS_LOCAL]) writeFileSync(join(root, rel), ORIGINAL);
}

function denyReason(outcome: CodingToolOutcome): string {
  expect(outcome.kind).toBe("denied");
  if (outcome.kind !== "denied") throw new Error("unreachable");
  return outcome.reason;
}

describe("B1: the canonical settings list drives both the sandbox and the native tool policy", () => {
  test("B1 AC-1: every CLAUDE_SETTINGS_FILES entry is refused to the native Write tool", async () => {
    expect(CLAUDE_SETTINGS_FILES).toEqual([SETTINGS, SETTINGS_LOCAL]);
    for (const rel of CLAUDE_SETTINGS_FILES) {
      const out = await runtime.callTool("Write", { path: rel, content: "{}" });
      expect(denyReason(out)).toContain(rel);
    }
  });

  test("B1 AC-1 boundary: the refusal names the file it refused and why it matters", async () => {
    const reason = denyReason(await runtime.callTool("Write", { path: SETTINGS, content: "{}" }));
    expect(reason).toStartWith("Write may not modify");
    expect(reason).toContain("settings file");
  });
});

describe("B1: the native Write tool cannot create or rewrite a settings file", () => {
  test("B1 AC-2: Write to .claude/settings.json is denied and creates no file", async () => {
    expect(existsSync(join(root, ".claude"))).toBe(false);
    await runtime.callTool("Write", { path: SETTINGS, content: "{}" });
    expect(existsSync(join(root, SETTINGS))).toBe(false);
  });

  test("B1 AC-2 boundary: Write to .claude/settings.local.json is denied", async () => {
    await runtime.callTool("Write", { path: SETTINGS_LOCAL, content: "{}" });
    expect(existsSync(join(root, SETTINGS_LOCAL))).toBe(false);
  });

  test("B1 AC-3: an existing settings file keeps its bytes when Write is refused", async () => {
    seedSettings();
    await runtime.callTool("Write", { path: SETTINGS, content: '{"permissions":{"allow":["Bash(*)"]}}' });
    expect(readFileSync(join(root, SETTINGS), "utf8")).toBe(ORIGINAL);
  });

  test("B1 AC-3 boundary: alternate spellings of the same file are refused too", async () => {
    seedSettings();
    for (const spelling of [`./${SETTINGS}`, `.claude/../${SETTINGS}`, SETTINGS_LOCAL]) {
      const out = await runtime.callTool("Write", { path: spelling, content: "{}" });
      expect(out.kind).toBe("denied");
    }
    for (const rel of [SETTINGS, SETTINGS_LOCAL]) expect(readFileSync(join(root, rel), "utf8")).toBe(ORIGINAL);
  });
});

describe("B1: Edit and Delete are covered by the same deny", () => {
  test("B1 AC-4: Edit on .claude/settings.json is denied and leaves the file alone", async () => {
    seedSettings();
    const out = await runtime.callTool("Edit", {
      path: SETTINGS,
      old_string: "Bash(*)",
      new_string: "Read(*)",
    });
    expect(denyReason(out)).toContain(SETTINGS);
    expect(readFileSync(join(root, SETTINGS), "utf8")).toBe(ORIGINAL);
  });

  test("B1 AC-5: Delete on .claude/settings.local.json is denied and the file survives", async () => {
    seedSettings();
    const out = await runtime.callTool("Delete", { path: SETTINGS_LOCAL });
    expect(denyReason(out)).toContain(SETTINGS_LOCAL);
    expect(readFileSync(join(root, SETTINGS_LOCAL), "utf8")).toBe(ORIGINAL);
  });
});

describe("B1: reads and every other .claude file stay reachable", () => {
  test("B1 AC-6: Read of .claude/settings.json still returns its content", async () => {
    seedSettings();
    const out = await runtime.callTool("Read", { path: SETTINGS });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("unreachable");
    expect(out.content).toContain(ORIGINAL);
  });

  test("B1 AC-7: a file BESIDE the settings files under .claude/ is still writable", async () => {
    const out = await runtime.callTool("Write", { path: ".claude/commands/ship.md", content: "# ship" });
    expect(out.kind).toBe("ok");
    expect(readFileSync(join(root, ".claude/commands/ship.md"), "utf8")).toBe("# ship");
  });

  test("B1 AC-7 boundary: the match is exact, not a prefix — a settings BACKUP is writable", async () => {
    const out = await runtime.callTool("Write", { path: `${SETTINGS}.bak`, content: "backup" });
    expect(out.kind).toBe("ok");
    expect(readFileSync(join(root, `${SETTINGS}.bak`), "utf8")).toBe("backup");
  });

  test("B1 AC-7 boundary: a settings file is refused with no grant of its own, so Read and Write do not share it", async () => {
    // A separate runtime whose ONLY grant is Write: the refusal must not depend
    // on Read having been granted alongside it.
    const writeOnly = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root),
    });
    const denied = await writeOnly.callTool("Write", { path: SETTINGS, content: "{}" });
    expect(denied.kind).toBe("denied");
    const readDenied = await writeOnly.callTool("Read", { path: SETTINGS });
    // Read is not granted here, so it is denied for being ungranted -- the
    // separation the test above pins from the other direction.
    expect(readDenied.kind).toBe("denied");
  });
});

describe("B2: a symlink cannot walk a write past the settings deny", () => {
  // The policy hands the guard its symlink-resolved spelling, so a settings path
  // that is a symlink arrives as its TARGET. The deny must follow the same
  // resolution, or `.claude/settings.json -> ../actual.json` reopens the file.
  const TARGET = "actual-settings.json";

  function seedSymlinkedSettings(): void {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, TARGET), ORIGINAL);
    symlinkSync(join(root, TARGET), join(root, SETTINGS));
  }

  test("B2: Write, Edit and Delete through a symlinked settings.json are denied and the target keeps its bytes", async () => {
    seedSymlinkedSettings();
    const outcomes = [
      await runtime.callTool("Write", { path: SETTINGS, content: "{}" }),
      await runtime.callTool("Edit", { path: SETTINGS, old_string: "Bash(*)", new_string: "Read(*)" }),
      await runtime.callTool("Delete", { path: SETTINGS }),
    ];
    for (const out of outcomes) expect(out.kind).toBe("denied");
    expect(readFileSync(join(root, TARGET), "utf8")).toBe(ORIGINAL);
  });

  test("B2 boundary: the symlink target is refused under its own name too, since it IS the settings content", async () => {
    seedSymlinkedSettings();
    const out = await runtime.callTool("Write", { path: TARGET, content: "{}" });
    expect(out.kind).toBe("denied");
    expect(readFileSync(join(root, TARGET), "utf8")).toBe(ORIGINAL);
  });

  test("B2: a symlinked .claude directory does not reopen a settings file that does not exist yet", async () => {
    mkdirSync(join(root, "claude-real"));
    symlinkSync(join(root, "claude-real"), join(root, ".claude"));
    for (const rel of CLAUDE_SETTINGS_FILES) {
      const out = await runtime.callTool("Write", { path: rel, content: "{}" });
      expect(out.kind).toBe("denied");
    }
    expect(existsSync(join(root, "claude-real/settings.json"))).toBe(false);
    expect(existsSync(join(root, "claude-real/settings.local.json"))).toBe(false);
  });

  test("B2 boundary: other files under a symlinked .claude directory stay writable", async () => {
    mkdirSync(join(root, "claude-real"));
    symlinkSync(join(root, "claude-real"), join(root, ".claude"));
    const out = await runtime.callTool("Write", { path: ".claude/commands/ship.md", content: "# ship" });
    expect(out.kind).toBe("ok");
    expect(readFileSync(join(root, "claude-real/commands/ship.md"), "utf8")).toBe("# ship");
  });
});
