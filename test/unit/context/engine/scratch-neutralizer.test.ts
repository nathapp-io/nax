import { describe, test, expect } from "bun:test";
import { neutralizeForAgent } from "../../../../src/context/engine/scratch-neutralizer";

describe("neutralizeForAgent", () => {
  describe("same agent — no-op", () => {
    test("returns content unchanged when source and target are the same", () => {
      const content = "I'll use the Read tool to check the file and then the Bash tool to run tests.";
      expect(neutralizeForAgent(content, "claude", "claude")).toBe(content);
    });

    test("returns content unchanged when both are empty string", () => {
      expect(neutralizeForAgent("some content", "", "")).toBe("some content");
    });
  });

  describe("claude → other agent neutralization", () => {
    test("replaces 'the Read tool' with 'a file read'", () => {
      const result = neutralizeForAgent("I used the Read tool to inspect the file.", "claude", "codex");
      expect(result).toBe("I used a file read to inspect the file.");
    });

    test("replaces 'the Edit tool' with 'a file edit'", () => {
      const result = neutralizeForAgent("Applied the Edit tool to fix the bug.", "claude", "gemini");
      expect(result).toBe("Applied a file edit to fix the bug.");
    });

    test("replaces 'the Write tool' with 'a file write'", () => {
      const result = neutralizeForAgent("Used the Write tool to create the file.", "claude", "codex");
      expect(result).toBe("Used a file write to create the file.");
    });

    test("replaces 'the Bash tool' with 'a shell command'", () => {
      const result = neutralizeForAgent("Ran the Bash tool to execute tests.", "claude", "codex");
      expect(result).toBe("Ran a shell command to execute tests.");
    });

    test("replaces 'the Grep tool' with 'a code search'", () => {
      const result = neutralizeForAgent("Used the Grep tool to find usages.", "claude", "gemini");
      expect(result).toBe("Used a code search to find usages.");
    });

    test("replaces 'the Glob tool' with 'a file search'", () => {
      const result = neutralizeForAgent("Called the Glob tool to list files.", "claude", "codex");
      expect(result).toBe("Called a file search to list files.");
    });

    test("replaces 'the Agent tool' with 'a sub-agent'", () => {
      const result = neutralizeForAgent("Delegated via the Agent tool.", "claude", "codex");
      expect(result).toBe("Delegated via a sub-agent.");
    });

    test("replaces 'the Task tool' with 'a sub-agent'", () => {
      const result = neutralizeForAgent("Launched the Task tool for analysis.", "claude", "gemini");
      expect(result).toBe("Launched a sub-agent for analysis.");
    });

    test("handles multiple replacements in one string", () => {
      const input = "I used the Read tool then the Bash tool to verify.";
      const result = neutralizeForAgent(input, "claude", "codex");
      expect(result).toBe("I used a file read then a shell command to verify.");
    });

    test("replacement is case-insensitive", () => {
      const result = neutralizeForAgent("used THE READ TOOL here", "claude", "codex");
      expect(result).toBe("used a file read here");
    });

    test("does not replace 'Read' when not preceded by 'the '", () => {
      const result = neutralizeForAgent("Read the file carefully.", "claude", "codex");
      expect(result).toBe("Read the file carefully.");
    });
  });

  describe("non-claude source — no tool substitution", () => {
    test("returns content unchanged when source is not claude", () => {
      const content = "Used the Read tool to inspect.";
      expect(neutralizeForAgent(content, "codex", "gemini")).toBe(content);
    });

    test("returns content unchanged when source is empty", () => {
      const content = "Used the Bash tool here.";
      expect(neutralizeForAgent(content, "", "claude")).toBe(content);
    });
  });

  describe("edge cases", () => {
    test("returns empty string unchanged", () => {
      expect(neutralizeForAgent("", "claude", "codex")).toBe("");
    });

    test("handles string with no tool references cleanly", () => {
      const content = "Tests passed. All files modified correctly.";
      expect(neutralizeForAgent(content, "claude", "codex")).toBe(content);
    });
  });
});
