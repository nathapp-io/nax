import { describe, expect, test } from "bun:test";
import {
  claudeSessionMeta,
  mcpToolRule,
  READ_ONLY_DISALLOWED_TOOLS,
  TOOL_HOST_SERVER_NAME,
} from "#src/client/pre-approval";
import { registryEntry } from "#src/client/registry";

describe("pre-approval (spec R12, §6.6; D4-a)", () => {
  test("the server is named nax and each tool gets one exact rule", () => {
    expect(TOOL_HOST_SERVER_NAME).toBe("nax");
    expect(mcpToolRule("fetch_page")).toBe("mcp__nax__fetch_page");
  });

  test("claude: _meta.claudeCode.options.allowedTools, one rule per tool, nothing else", () => {
    expect(claudeSessionMeta(registryEntry("claude")?.preApproval, ["lookup", "fetch-page"], "full")).toEqual({
      claudeCode: { options: { allowedTools: ["mcp__nax__lookup", "mcp__nax__fetch-page"] } },
    });
  });
});

// #2365: under plan mode Claude asks to leave it with ExitPlanMode; the adapter turns
// that reject into an interrupt, so the turn ended ACP_STOP_CANCELLED.
describe("claude session _meta by profile (#2365)", () => {
  const claude = registryEntry("claude")?.preApproval;

  test("none and read disallow ExitPlanMode, with or without tools", () => {
    expect(READ_ONLY_DISALLOWED_TOOLS).toEqual(["ExitPlanMode"]);
    for (const profile of ["none", "read"] as const) {
      expect(claudeSessionMeta(claude, [], profile)).toEqual({
        claudeCode: { options: { disallowedTools: ["ExitPlanMode"] } },
      });
      expect(claudeSessionMeta(claude, ["lookup"], profile)).toEqual({
        claudeCode: { options: { allowedTools: ["mcp__nax__lookup"], disallowedTools: ["ExitPlanMode"] } },
      });
    }
  });

  test("ask and full: only the tool rules, and nothing without tools", () => {
    for (const profile of ["ask", "full"] as const) {
      expect(claudeSessionMeta(claude, ["lookup"], profile)).toEqual({
        claudeCode: { options: { allowedTools: ["mcp__nax__lookup"] } },
      });
      expect(claudeSessionMeta(claude, [], profile)).toBeUndefined();
    }
  });

  test("an agent that is not Claude gets no _meta under any profile", () => {
    expect(claudeSessionMeta(registryEntry("codex")?.preApproval, ["lookup"], "read")).toBeUndefined();
    expect(claudeSessionMeta(undefined, [], "none")).toBeUndefined();
  });
});
