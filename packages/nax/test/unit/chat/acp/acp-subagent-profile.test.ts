/** US-003 AC-1..AC-11: ACP subagent profile derivation and the own-read-only-enforcement capability check. */
import { describe, expect, test } from "bun:test";
import type { AcpChatAgent } from "@/chat/acp/acp-model";
import {
  ACP_SUBAGENT_WRITE_TOOLS,
  type AcpSubagentProfile,
  acpReadOnlyEnforced,
  acpSubagentProfile,
  isReadOnlyAcpProfile,
} from "@/chat/acp/acp-subagent-profile";

describe("acpSubagentProfile", () => {
  test("AC-1 returns review when the tools list names no write tool in a guarded chat", () => {
    expect(acpSubagentProfile({ tools: ["Read", "Grep", "Bash"], mode: "guarded" })).toBe("review");
  });

  test("AC-2 returns review for an empty tools list in a full chat", () => {
    expect(acpSubagentProfile({ tools: [], mode: "full" })).toBe("review");
  });

  test("AC-3 returns the chat's guarded profile when the tools list names a write tool", () => {
    expect(acpSubagentProfile({ tools: ["Read", "Edit"], mode: "guarded" })).toBe("ask");
  });

  test("AC-4 returns the chat's full profile when a bare-name-matched write tool carries a pattern", () => {
    expect(acpSubagentProfile({ tools: ["Read", "Write(src/**)"], mode: "full" })).toBe("full");
  });

  test("AC-5 returns ask when the agent file has no tools line in a guarded chat", () => {
    expect(acpSubagentProfile({ tools: undefined, mode: "guarded" })).toBe("ask");
  });

  test("AC-6 returns full when the agent file has no tools line in a full chat", () => {
    expect(acpSubagentProfile({ tools: undefined, mode: "full" })).toBe("full");
  });

  test("AC-7 lets the override widen a guarded read-only agent to full", () => {
    expect(acpSubagentProfile({ tools: ["Read"], mode: "guarded", override: "full" })).toBe("full");
  });

  test("AC-8 lets the override narrow a full write agent to read", () => {
    expect(acpSubagentProfile({ tools: ["Write"], mode: "full", override: "read" })).toBe("read");
  });

  test.each(ACP_SUBAGENT_WRITE_TOOLS.map((name) => [name]))(
    "AC-9 returns the chat's guarded profile for the write tool %s",
    (name) => {
      expect(acpSubagentProfile({ tools: [name], mode: "guarded" })).toBe("ask");
    },
  );

  test("names exactly the six write tools", () => {
    expect(ACP_SUBAGENT_WRITE_TOOLS).toEqual(["Write", "Edit", "MultiEdit", "NotebookEdit", "Delete", "GitCommit"]);
  });

  test("reads a bare tool name even when the entry carries arguments", () => {
    expect(acpSubagentProfile({ tools: ["Edit(src/**)"], mode: "guarded" })).toBe("ask");
    expect(acpSubagentProfile({ tools: ["NotebookEdit(*.ipynb)"], mode: "guarded" })).toBe("ask");
  });

  test("does not treat Bash as a write tool", () => {
    expect(acpSubagentProfile({ tools: ["Bash"], mode: "guarded" })).toBe("review");
  });
});

describe("acpSubagentProfile when unattended", () => {
  test("US-001 AC-1: an agent with no tools line opens read-only on review in a guarded run", () => {
    expect(acpSubagentProfile({ tools: undefined, mode: "guarded", unattended: true })).toBe("review");
  });

  test("US-001 AC-2: an agent with no tools line opens read-only on review in a full run", () => {
    expect(acpSubagentProfile({ tools: undefined, mode: "full", unattended: true })).toBe("review");
  });

  test("US-001 AC-3: a declared write tool still inherits the guarded profile", () => {
    expect(acpSubagentProfile({ tools: ["Read", "Write"], mode: "guarded", unattended: true })).toBe("ask");
  });

  test("US-001 AC-4: a declared write tool still inherits the full profile", () => {
    expect(acpSubagentProfile({ tools: ["Read", "Edit"], mode: "full", unattended: true })).toBe("full");
  });

  test("US-001 AC-5: a read-only tools list stays on review", () => {
    expect(acpSubagentProfile({ tools: ["Read", "Grep"], mode: "guarded", unattended: true })).toBe("review");
  });

  test("US-001 AC-6: the operator override still wins over the unattended default", () => {
    expect(acpSubagentProfile({ tools: undefined, mode: "guarded", override: "full", unattended: true })).toBe("full");
  });

  test("US-001 AC-7: an attended chat still inherits its own guarded profile", () => {
    expect(acpSubagentProfile({ tools: undefined, mode: "guarded" })).toBe("ask");
  });
});

describe("isReadOnlyAcpProfile", () => {
  const table: readonly (readonly [AcpSubagentProfile, boolean])[] = [
    ["review", true],
    ["read", true],
    ["ask", false],
    ["full", false],
  ];

  test.each(table)("AC-10 isReadOnlyAcpProfile(%s) is %s", (profile, expected) => {
    expect(isReadOnlyAcpProfile(profile)).toBe(expected);
  });
});

describe("acpReadOnlyEnforced", () => {
  const table: readonly (readonly [AcpChatAgent, boolean])[] = [
    ["claude", true],
    ["codex", true],
    ["cursor", false],
  ];

  test.each(table)("AC-11 acpReadOnlyEnforced(%s) is %s", (agent, expected) => {
    expect(acpReadOnlyEnforced(agent)).toBe(expected);
  });
});
