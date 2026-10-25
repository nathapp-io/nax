import { afterEach, describe, expect, test } from "bun:test";
import { _claudePathsDeps, claudeConfigDir, claudeJsonPath } from "@/resources/claude-paths";

const originalHomedir = _claudePathsDeps.homedir;
afterEach(() => {
  _claudePathsDeps.homedir = originalHomedir;
});

describe("claudeConfigDir", () => {
  test("AC-4 returns the Claude Code override unchanged", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/x/claude" })).toBe("/x/claude");
  });

  test("preserves an explicitly set empty override", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "" })).toBe("");
  });

  test("AC-5 defaults to .claude under the injected home", () => {
    _claudePathsDeps.homedir = () => "/home/u";
    expect(claudeConfigDir({})).toBe("/home/u/.claude");
  });
});

describe("claudeJsonPath", () => {
  test("AC-1 places .claude.json inside CLAUDE_CONFIG_DIR", () => {
    expect(claudeJsonPath({ CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/.claude.json");
  });

  test("AC-2 defaults to .claude.json under the injected home", () => {
    _claudePathsDeps.homedir = () => "/home/u";
    expect(claudeJsonPath({})).toBe("/home/u/.claude.json");
  });
});
