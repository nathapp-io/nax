import { describe, expect, test } from "bun:test";
import { mcpToolRule, preApprovalMeta, TOOL_HOST_SERVER_NAME } from "#src/client/pre-approval";
import { registryEntry } from "#src/client/registry";

describe("pre-approval (spec R12, §6.6; D4-a)", () => {
  test("the server is named nax and each tool gets one exact rule", () => {
    expect(TOOL_HOST_SERVER_NAME).toBe("nax");
    expect(mcpToolRule("fetch_page")).toBe("mcp__nax__fetch_page");
  });

  test("claude: _meta.claudeCode.options.allowedTools, one rule per tool, nothing else", () => {
    expect(preApprovalMeta(registryEntry("claude")?.preApproval, ["lookup", "fetch-page"])).toEqual({
      claudeCode: { options: { allowedTools: ["mcp__nax__lookup", "mcp__nax__fetch-page"] } },
    });
  });

  test("an agent without a pre-approval mechanism: none", () => {
    expect(preApprovalMeta(registryEntry("codex")?.preApproval, ["lookup"])).toBeUndefined();
    expect(preApprovalMeta(undefined, ["lookup"])).toBeUndefined();
  });
});
