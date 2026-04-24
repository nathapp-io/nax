import { describe, test, expect } from "bun:test";
import { auditMiddleware } from "../../../../src/runtime/middleware/audit";
import { createNoOpPromptAuditor, type PromptAuditEntry } from "../../../../src/runtime/prompt-auditor";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { MiddlewareContext } from "../../../../src/runtime/agent-middleware";

function makeCtx(kind: "run" | "complete" = "complete"): MiddlewareContext {
  return {
    runId: "r-001", agentName: "claude", kind,
    request: null, prompt: kind === "complete" ? "Do the thing" : null,
    config: DEFAULT_CONFIG,
    resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
    storyId: "s-1", stage: "run",
  };
}

describe("auditMiddleware", () => {
  test("after() records PromptAuditEntry for complete calls", async () => {
    const recorded: PromptAuditEntry[] = [];
    const aud = { ...createNoOpPromptAuditor(), record: (e: PromptAuditEntry) => recorded.push(e) };
    const mw = auditMiddleware(aud, "r-001");
    await mw.after!(makeCtx("complete"), { output: "Done" }, 150);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].prompt).toBe("Do the thing");
    expect(recorded[0].response).toBe("Done");
    expect(recorded[0].permissionProfile).toBe("approve-reads");
    expect(recorded[0].durationMs).toBe(150);
  });

  test("after() is a no-op when prompt and request are both null", async () => {
    const recorded: PromptAuditEntry[] = [];
    const aud = { ...createNoOpPromptAuditor(), record: (e: PromptAuditEntry) => recorded.push(e) };
    const mw = auditMiddleware(aud, "r-001");
    const ctx = makeCtx("run");
    // request is null and prompt is null — no audit data
    await mw.after!(ctx, { output: "" }, 10);
    expect(recorded).toHaveLength(0);
  });

  test("onError() records PromptAuditErrorEntry", async () => {
    const errors: unknown[] = [];
    const aud = { ...createNoOpPromptAuditor(), recordError: (e: unknown) => errors.push(e) };
    const mw = auditMiddleware(aud, "r-001");
    await mw.onError!(makeCtx(), new Error("fail"), 80);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Record<string, unknown>).agentName).toBe("claude");
    expect((errors[0] as Record<string, unknown>).durationMs).toBe(80);
  });
});
