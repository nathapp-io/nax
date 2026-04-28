import { describe, test, expect } from "bun:test";
import { auditMiddleware } from "../../../../src/runtime/middleware/audit";
import {
  createNoOpPromptAuditor,
  type PromptAuditEntry,
  type PromptAuditErrorEntry,
} from "../../../../src/runtime/prompt-auditor";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { NaxError } from "../../../../src/errors";
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

  test("after() records callType, workdir, featureName from runOptions", async () => {
    const recorded: PromptAuditEntry[] = [];
    const aud = { ...createNoOpPromptAuditor(), record: (e: PromptAuditEntry) => recorded.push(e) };
    const mw = auditMiddleware(aud, "r-001");
    const ctx: MiddlewareContext = {
      runId: "r-001", agentName: "claude", kind: "run",
      request: { runOptions: { prompt: "hello", workdir: "/tmp/w", projectDir: "/tmp/p", featureName: "feat-x" } as never },
      prompt: null,
      config: DEFAULT_CONFIG,
      resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
      storyId: "s-1", stage: "run",
    };
    await mw.after!(ctx, { output: "ok" }, 100);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].callType).toBe("run");
    expect(recorded[0].workdir).toBe("/tmp/w");
    expect(recorded[0].projectDir).toBe("/tmp/p");
    expect(recorded[0].featureName).toBe("feat-x");
  });

  test("after() records session-style name for complete calls with feature context", async () => {
    const recorded: PromptAuditEntry[] = [];
    const aud = { ...createNoOpPromptAuditor(), record: (e: PromptAuditEntry) => recorded.push(e) };
    const mw = auditMiddleware(aud, "r-001");
    const ctx: MiddlewareContext = {
      runId: "r-001", agentName: "claude", kind: "complete",
      request: null,
      completeOptions: {
        config: DEFAULT_CONFIG,
        workdir: "/tmp/w",
        featureName: "Feat X",
        storyId: "US-001",
        sessionRole: "refine",
        pipelineStage: "acceptance",
      },
      prompt: "hello",
      config: DEFAULT_CONFIG,
      resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
      storyId: "US-001", stage: "acceptance",
    };
    await mw.after!(ctx, { output: "ok" }, 100);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].sessionName).toStartWith("nax-");
    expect(recorded[0].sessionName).toEndWith("-feat-x-us-001-refine");
    expect(recorded[0].featureName).toBe("Feat X");
    expect(recorded[0].workdir).toBe("/tmp/w");
  });

  test("after() skips outer runAs audit when executeHop handles session audit", async () => {
    const recorded: PromptAuditEntry[] = [];
    const aud = { ...createNoOpPromptAuditor(), record: (e: PromptAuditEntry) => recorded.push(e) };
    const mw = auditMiddleware(aud, "r-001");
    const ctx: MiddlewareContext = {
      runId: "r-001", agentName: "claude", kind: "run",
      request: {
        runOptions: { prompt: "hello", workdir: "/tmp/w", projectDir: "/tmp/p", featureName: "feat-x" } as never,
        executeHop: async () => ({ result: {} as never, bundle: undefined }),
      },
      prompt: "hello",
      config: DEFAULT_CONFIG,
      resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
      storyId: "s-1", stage: "run",
    };
    await mw.after!(ctx, { output: "ok" }, 100);
    expect(recorded).toHaveLength(0);
  });

  test("after() records ACP session correlation from MiddlewareContext.sessionHandle", async () => {
    const recorded: PromptAuditEntry[] = [];
    const aud = { ...createNoOpPromptAuditor(), record: (e: PromptAuditEntry) => recorded.push(e) };
    const mw = auditMiddleware(aud, "r-001");
    const ctx: MiddlewareContext = {
      runId: "r-001", agentName: "claude", kind: "run",
      request: { runOptions: { prompt: "p", workdir: "/tmp" } as never },
      prompt: null,
      config: DEFAULT_CONFIG,
      resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
      storyId: "s-1", stage: "run",
      sessionHandle: { id: "nax-abc-feat-x", agentName: "claude" },
    };
    const result = {
      success: true, output: "done",
      protocolIds: { recordId: "rec-1", sessionId: "sess-1" },
      internalRoundTrips: 3,
    };
    await mw.after!(ctx, result, 200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].sessionName).toBe("nax-abc-feat-x");
    expect(recorded[0].recordId).toBe("rec-1");
    expect(recorded[0].sessionId).toBe("sess-1");
    expect(recorded[0].turn).toBe(3);
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

  test("onError() captures prompt, callType, workdir, featureName, and NaxError code", async () => {
    const errors: PromptAuditErrorEntry[] = [];
    const aud = { ...createNoOpPromptAuditor(), recordError: (e: PromptAuditErrorEntry) => errors.push(e) };
    const mw = auditMiddleware(aud, "r-001");
    const ctx: MiddlewareContext = {
      runId: "r-001",
      agentName: "claude",
      kind: "run",
      request: {
        runOptions: { prompt: "implement feature", workdir: "/tmp/w", projectDir: "/tmp/p", featureName: "feat-x" } as never,
      },
      prompt: null,
      config: DEFAULT_CONFIG,
      resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
      storyId: "s-1",
      stage: "run",
    };
    const err = new NaxError("session lost", "SESSION_ERROR", { stage: "run" });
    await mw.onError!(ctx, err, 42);
    expect(errors).toHaveLength(1);
    expect(errors[0].callType).toBe("run");
    expect(errors[0].prompt).toBe("implement feature");
    expect(errors[0].workdir).toBe("/tmp/w");
    expect(errors[0].projectDir).toBe("/tmp/p");
    expect(errors[0].featureName).toBe("feat-x");
    expect(errors[0].permissionProfile).toBe("approve-reads");
    expect(errors[0].errorCode).toBe("SESSION_ERROR");
    expect(errors[0].errorMessage).toBe("session lost");
  });

  test("onError() captures prompt for complete-kind calls from ctx.prompt", async () => {
    const errors: PromptAuditErrorEntry[] = [];
    const aud = { ...createNoOpPromptAuditor(), recordError: (e: PromptAuditErrorEntry) => errors.push(e) };
    const mw = auditMiddleware(aud, "r-001");
    await mw.onError!(makeCtx("complete"), new Error("boom"), 10);
    expect(errors).toHaveLength(1);
    expect(errors[0].callType).toBe("complete");
    expect(errors[0].prompt).toBe("Do the thing");
    expect(errors[0].errorCode).toBe("UNKNOWN");
    expect(errors[0].errorMessage).toBe("boom");
  });
});
