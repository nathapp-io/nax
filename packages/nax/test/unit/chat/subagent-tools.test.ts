import { describe, expect, test } from "bun:test";

describe("mapSubagentTools", () => {
  test("AC-10: absent tools yields no allowedTools key", async () => {
    const { mapSubagentTools } = await import("@/chat/subagent-tools");
    const result = mapSubagentTools(undefined);
    expect(result).toEqual({ dropped: [] });
    expect("allowedTools" in result).toBe(false);
  });

  test("AC-11: passes through nax tool names", async () => {
    const { mapSubagentTools } = await import("@/chat/subagent-tools");
    expect(mapSubagentTools(["Read", "Grep", "Bash"])).toEqual({
      allowedTools: ["Read", "Grep", "Bash"],
      dropped: [],
    });
  });

  test.each(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Git", "Delete", "GitCommit"])(
    "passes %s through unchanged",
    async (name) => {
      const { mapSubagentTools } = await import("@/chat/subagent-tools");
      expect(mapSubagentTools([name])).toEqual({ allowedTools: [name], dropped: [] });
    },
  );

  test("AC-12: maps MultiEdit to Edit and de-duplicates in first-seen order", async () => {
    const { mapSubagentTools } = await import("@/chat/subagent-tools");
    expect(mapSubagentTools(["MultiEdit", "Edit"]).allowedTools).toEqual(["Edit"]);
  });

  test("AC-13: maps Skill to the nax-skills wildcard", async () => {
    const { mapSubagentTools } = await import("@/chat/subagent-tools");
    expect(mapSubagentTools(["Skill"]).allowedTools).toEqual(["nax-skills__*"]);
  });

  test("AC-14: maps MCP tool and server entries", async () => {
    const { mapSubagentTools } = await import("@/chat/subagent-tools");
    expect(mapSubagentTools(["mcp__docs__search", "mcp__db"]).allowedTools).toEqual(["docs__search", "db__*"]);
  });

  test("maps a plugin MCP name without translating the plugin server id", async () => {
    const { mapSubagentTools } = await import("@/chat/subagent-tools");
    expect(mapSubagentTools(["mcp__plugin_p_s__t"]).allowedTools).toEqual(["plugin_p_s__t"]);
  });

  test("AC-15: strips a Claude Code tool pattern", async () => {
    const { mapSubagentTools } = await import("@/chat/subagent-tools");
    expect(mapSubagentTools(["Bash(git diff:*)"]).allowedTools).toEqual(["Bash"]);
  });

  test("drops a patterned entry whose bare name has no nax equivalent", async () => {
    const { mapSubagentTools } = await import("@/chat/subagent-tools");
    expect(mapSubagentTools(["WebFetch(domain:x.com)"])).toEqual({
      allowedTools: [],
      dropped: [{ name: "WebFetch(domain:x.com)", reason: "no nax equivalent" }],
    });
  });

  test("AC-16: drops Agent and Task and yields an empty allowedTools", async () => {
    const { mapSubagentTools } = await import("@/chat/subagent-tools");
    expect(mapSubagentTools(["Agent", "Task"])).toEqual({
      allowedTools: [],
      dropped: [
        { name: "Agent", reason: "subagents cannot start subagents" },
        { name: "Task", reason: "subagents cannot start subagents" },
      ],
    });
  });

  test("AC-17: drops tools with no nax equivalent", async () => {
    const { mapSubagentTools } = await import("@/chat/subagent-tools");
    expect(mapSubagentTools(["Read", "WebFetch"])).toEqual({
      allowedTools: ["Read"],
      dropped: [{ name: "WebFetch", reason: "no nax equivalent" }],
    });
  });

  test("AC-19: is exposed from the @/chat barrel", async () => {
    const chat = await import("@/chat");
    expect(typeof chat.mapSubagentTools).toBe("function");
    const result = chat.mapSubagentTools(undefined);
    expect(result).toEqual({ dropped: [] });
    expect("allowedTools" in result).toBe(false);
  });

  test("drops an empty mcp__ entry", async () => {
    const { mapSubagentTools } = await import("@/chat/subagent-tools");
    expect(mapSubagentTools(["mcp__"]).dropped).toEqual([{ name: "mcp__", reason: "no nax equivalent" }]);
  });
});
