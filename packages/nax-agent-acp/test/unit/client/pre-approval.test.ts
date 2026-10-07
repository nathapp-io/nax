import { describe, expect, test } from "bun:test";
import { readOnlyFor } from "#src/client/capabilities";
import { claudeSessionMeta, mcpToolRule, TOOL_HOST_SERVER_NAME } from "#src/client/pre-approval";
import { registryEntry } from "#src/client/registry";

describe("pre-approval (spec R12, §6.6; D4-a)", () => {
  test("the server is named nax and each tool gets one exact rule", () => {
    expect(TOOL_HOST_SERVER_NAME).toBe("nax");
    expect(mcpToolRule("fetch_page")).toBe("mcp__nax__fetch_page");
  });

  test("claude: _meta.claudeCode.options.allowedTools, one rule per tool, nothing else", () => {
    expect(claudeSessionMeta(registryEntry("claude")?.preApproval, ["lookup", "fetch-page"], undefined)).toEqual({
      claudeCode: { options: { allowedTools: ["mcp__nax__lookup", "mcp__nax__fetch-page"] } },
    });
  });
});

// #2366: none/read on Claude are default mode with the write tools removed and no settings files.
describe("claude session _meta by profile (#2366)", () => {
  const claude = registryEntry("claude");
  const READ_ONLY_OPTIONS = {
    disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "EnterPlanMode"],
    settingSources: [],
    allowDangerouslySkipPermissions: false,
  };

  test("none and read: the removed tools and the settings lock, with or without tools", () => {
    for (const profile of ["none", "read"] as const) {
      const readOnly = readOnlyFor(profile, claude);
      expect(claudeSessionMeta(claude?.preApproval, [], readOnly)).toEqual({
        claudeCode: { options: READ_ONLY_OPTIONS },
      });
      expect(claudeSessionMeta(claude?.preApproval, ["lookup"], readOnly)).toEqual({
        claudeCode: { options: { allowedTools: ["mcp__nax__lookup"], ...READ_ONLY_OPTIONS } },
      });
    }
  });

  test("ask and full: only the tool rules, and nothing without tools", () => {
    for (const profile of ["ask", "full"] as const) {
      const readOnly = readOnlyFor(profile, claude);
      expect(readOnly).toBeUndefined();
      expect(claudeSessionMeta(claude?.preApproval, ["lookup"], readOnly)).toEqual({
        claudeCode: { options: { allowedTools: ["mcp__nax__lookup"] } },
      });
      expect(claudeSessionMeta(claude?.preApproval, [], readOnly)).toBeUndefined();
    }
  });

  test("an agent that is not Claude gets no _meta under any profile", () => {
    const codex = registryEntry("codex");
    expect(claudeSessionMeta(codex?.preApproval, ["lookup"], readOnlyFor("read", codex))).toBeUndefined();
    expect(claudeSessionMeta(undefined, [], undefined)).toBeUndefined();
  });
});
