/**
 * S3-4: createAgentSession's option validation (spec 4.1, 7). zod checks the
 * shape; profile rules, reserved tool names and the model spec are checked
 * after it. The caller's objects are kept, never zod's copies, so an embedder
 * tool written as a class keeps its `this`.
 */
import { describe, expect, test } from "bun:test";
import type { EmbedderTool } from "@nathapp/nax-agent";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  resolveAgentSessionOptions,
} from "#src/session/agent-session-options";
import { assertNaxError } from "#test/helpers/index";

const echo: EmbedderTool = {
  name: "echo",
  description: "echo the input",
  inputSchema: { type: "object" },
  approval: "never",
  async run(input) {
    return { content: JSON.stringify(input) };
  },
};

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backend: "native",
    model: "openai/gpt-5.4-mini",
    profile: "none",
    transcriptStore: createMemoryTranscriptStore(),
    ...extra,
  };
}

function rejects(input: unknown, code: string, fragment: string): void {
  let caught: unknown;
  try {
    resolveAgentSessionOptions(input);
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe(code);
  expect(caught.message).toContain(fragment);
}

describe("resolveAgentSessionOptions", () => {
  test("applies the defaults and keeps the caller's objects", () => {
    const input = base({ tools: [echo] });
    const resolved = resolveAgentSessionOptions(input);
    expect(resolved.raw).toBe<unknown>(input);
    expect(resolved.tools[0]).toBe(echo);
    expect(resolved.provider).toBe("openai");
    expect(resolved.approvalTimeoutMs).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(resolved.turnTimeoutSeconds).toBe(DEFAULT_TURN_TIMEOUT_SECONDS);
    expect(resolved.bashApproval).toBe("gated");
    expect(resolved.allowUnsandboxed).toBe(false);
    expect(resolved.metadata).toEqual({});
  });

  test("a class-based tool keeps `this`", async () => {
    class Counter implements EmbedderTool {
      readonly name = "count";
      readonly description = "count";
      readonly inputSchema = { type: "object" };
      readonly approval = "never" as const;
      private calls = 0;
      async run() {
        this.calls += 1;
        return { content: String(this.calls) };
      }
    }
    const tool = new Counter();
    const resolved = resolveAgentSessionOptions(base({ tools: [tool] }));
    const ctx = { sessionId: "s", toolCallId: "c", signal: new AbortController().signal };
    expect((await resolved.tools[0]?.run({}, ctx))?.content).toBe("1");
  });

  test.each([["../escape"], ["a/b"], [""], [".hidden"], ["x".repeat(129)]])(
    "rejects the path-shaped or oversized sessionId %p before any store call",
    (sessionId) => {
      rejects(base({ sessionId }), "AGENT_SESSION_INVALID_OPTIONS", "sessionId");
    },
  );

  test("accepts a 128-character id of letters, digits, dot, dash and underscore", () => {
    const sessionId = `a${"b._-9".repeat(25)}xy`;
    expect(sessionId).toHaveLength(128);
    expect(() => resolveAgentSessionOptions(base({ sessionId }))).not.toThrow();
  });

  test("rejects unknown keys (typos)", () => {
    rejects(base({ profle: "read" }), "AGENT_SESSION_INVALID_OPTIONS", "profle");
  });

  test("rejects the reserved mcpServers option, even when undefined", () => {
    rejects(base({ mcpServers: undefined }), "AGENT_SESSION_INVALID_OPTIONS", "mcpServers");
  });

  test("hostPorts.runDeclaredCommand is refused as deferred", () => {
    rejects(base({ hostPorts: { runDeclaredCommand: async () => ({}) } }), "AGENT_SESSION_INVALID_OPTIONS", "deferred");
  });

  test("read and full need an absolute workdir", () => {
    rejects(base({ profile: "read" }), "AGENT_SESSION_INVALID_OPTIONS", "workdir");
    rejects(base({ profile: "full", workdir: "relative/dir" }), "AGENT_SESSION_INVALID_OPTIONS", "workdir");
  });

  test("bashApproval and allowUnsandboxed are full-only", () => {
    rejects(base({ bashApproval: "raw" }), "AGENT_SESSION_INVALID_OPTIONS", "bashApproval");
    rejects(
      base({ profile: "read", workdir: "/tmp", allowUnsandboxed: true }),
      "AGENT_SESSION_INVALID_OPTIONS",
      "allowUnsandboxed",
    );
  });

  test("allowUnsandboxed needs bashApproval gated", () => {
    const full = { profile: "full", workdir: "/tmp", allowUnsandboxed: true };
    rejects(base({ ...full, bashApproval: "raw" }), "AGENT_SESSION_INVALID_OPTIONS", "allowUnsandboxed");
    expect(resolveAgentSessionOptions(base(full)).allowUnsandboxed).toBe(true);
  });

  test("approvalTimeoutMs and turnTimeoutSeconds are range-checked", () => {
    rejects(base({ approvalTimeoutMs: 29_999 }), "AGENT_SESSION_INVALID_OPTIONS", "approvalTimeoutMs");
    rejects(base({ approvalTimeoutMs: 3_600_001 }), "AGENT_SESSION_INVALID_OPTIONS", "approvalTimeoutMs");
    rejects(base({ turnTimeoutSeconds: 0 }), "AGENT_SESSION_INVALID_OPTIONS", "turnTimeoutSeconds");
    expect(resolveAgentSessionOptions(base({ approvalTimeoutMs: 30_000 })).approvalTimeoutMs).toBe(30_000);
  });

  test("a malformed model spec is an invalid option", () => {
    rejects(base({ model: "no-provider" }), "AGENT_SESSION_INVALID_OPTIONS", "model");
  });

  test("a protectedPaths policy without its arrays is rejected", () => {
    rejects(
      base({ hostPorts: { protectedPaths: { credentialDir: "/x" } } }),
      "AGENT_SESSION_INVALID_OPTIONS",
      "protectedPaths",
    );
  });

  test("a transcriptStore missing markTurn is rejected", () => {
    const { markTurn: _dropped, ...partial } = createMemoryTranscriptStore();
    rejects(base({ transcriptStore: partial }), "AGENT_SESSION_INVALID_OPTIONS", "transcriptStore");
  });

  test.each([["Read"], ["Bash"], ["ScratchpadRead"], ["ask_human"]])("tool name %p is reserved", (name) => {
    rejects(base({ tools: [{ ...echo, name }] }), "AGENT_SESSION_TOOL_NAME_RESERVED", name);
  });

  test("duplicate and malformed tool names are invalid", () => {
    rejects(base({ tools: [echo, echo] }), "AGENT_SESSION_INVALID_OPTIONS", "echo");
    rejects(base({ tools: [{ ...echo, name: "has space" }] }), "AGENT_SESSION_INVALID_OPTIONS", "name");
  });

  test("a tool without run is invalid", () => {
    const { run: _dropped, ...noRun } = echo;
    rejects(base({ tools: [noRun] }), "AGENT_SESSION_INVALID_OPTIONS", "run");
  });

  test("a non-object input is invalid", () => {
    rejects(undefined, "AGENT_SESSION_INVALID_OPTIONS", "options");
  });
});
