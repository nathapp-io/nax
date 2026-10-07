import { describe, expect, test } from "bun:test";
import type { OpenSessionOpts, ToolAuditHeader, TurnEvent } from "@nathapp/nax-agent";

describe("S4b additive contract (spec §7.4, §8)", () => {
  test("OpenSessionOpts accepts an optional toolAudit with a dir and a header", () => {
    const header: ToolAuditHeader = { runId: "r-1", featureName: "f", storyId: "US-001", sessionRole: "implementer" };
    const audit: OpenSessionOpts["toolAudit"] = { dir: "/tmp/audit", header };
    expect(audit).toEqual({ dir: "/tmp/audit", header });
    const absent: OpenSessionOpts["toolAudit"] = undefined;
    expect(absent).toBeUndefined();
  });

  test("a tool_result event may carry resultBytes, and may omit it", () => {
    const withBytes: TurnEvent = { type: "tool_result", callId: "c1", isError: false, preview: "ok", resultBytes: 2 };
    const without: TurnEvent = { type: "tool_result", callId: "c1", isError: false, preview: "ok" };
    expect(withBytes.type === "tool_result" ? withBytes.resultBytes : -1).toBe(2);
    expect(without.type === "tool_result" ? without.resultBytes : -1).toBeUndefined();
  });
});
