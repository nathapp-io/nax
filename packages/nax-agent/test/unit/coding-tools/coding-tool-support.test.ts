/**
 * `buildCodingToolSupport` carries the rendered `## MCP servers` section
 * (#2517) untouched: the resolver renders it (nax's
 * `resolveCodingToolSupport`), and the session open reads it back off the
 * support. This module only passes it through.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { buildCodingToolSupport } from "#src/coding-tools/coding-tool-support";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

let root: string;
beforeEach(() => {
  root = realpathSync(makeTempDir("coding-tool-support-"));
  mkdirSync(join(root, ".git"), { recursive: true });
});
afterEach(() => cleanupTempDir(root));

/** The minimum that builds a session: one declared tool, granted. */
const support = (extra: { providerInstructions?: string } = {}) =>
  buildCodingToolSupport({ root, declared: ["Read"], grants: [{ tool: "Read", patterns: ["*"] }], ...extra });

describe("buildCodingToolSupport — providerInstructions", () => {
  test("carries the rendered section onto the support", () => {
    expect(support({ providerInstructions: "X" })?.providerInstructions).toBe("X");
  });

  test("a support built without one has no providerInstructions key", () => {
    expect("providerInstructions" in (support() ?? {})).toBe(false);
  });
});

/** A support that declares Bash, so the session-local tool is really built. */
const bashSupport = (extra: { unsandboxedCommands?: boolean } = {}) =>
  buildCodingToolSupport({
    root,
    declared: ["Read", "Bash"],
    grants: [
      { tool: "Read", patterns: ["*"] },
      { tool: "Bash", patterns: ["*"] },
    ],
    ...extra,
  });

/** The Bash tool's `properties` keys, without casting to a Capitalised type. */
function bashPropertyKeys(tool: { readonly inputSchema: Record<string, unknown> }): string[] {
  const properties: unknown = tool.inputSchema.properties;
  if (typeof properties !== "object" || properties === null) {
    throw new Error("expected the Bash tool's inputSchema.properties to be an object");
  }
  return Object.keys(properties).sort();
}

describe("buildCodingToolSupport — unsandboxedCommands (US-003)", () => {
  test("AC-12: the option reaches the Bash tool's advertised schema", () => {
    const built = bashSupport({ unsandboxedCommands: true });
    const bash = built?.tools.find((tool) => tool.name === "Bash");
    if (bash === undefined) throw new Error("expected an advertised Bash tool");
    expect(bashPropertyKeys(bash)).toContain("unsandboxed");
  });

  test("AC-12 boundary: without the option the Bash schema has no unsandboxed key", () => {
    const built = bashSupport();
    const bash = built?.tools.find((tool) => tool.name === "Bash");
    if (bash === undefined) throw new Error("expected an advertised Bash tool");
    expect(bashPropertyKeys(bash)).not.toContain("unsandboxed");
  });
});

/**
 * US-005: `unsandboxedCommands` is not only an advertisement (US-003) — it is
 * also the runtime's permission to run a call outside the sandbox at all. The
 * pair below is how the story makes the forwarding observable: the same
 * escaping `Bash` call reaches an approval request when the option is on, and
 * the `allowUnsandboxedCommands` refusal when it is not. The ask rule is the
 * one every `gated` session profile configures, and the resolver denies, so no
 * command ever runs.
 */
describe("buildCodingToolSupport — unsandboxed runtime option (US-005)", () => {
  const NOT_ENABLED = "unsandboxed commands are not enabled for this session (allowUnsandboxedCommands)";

  /** A Bash-declaring support whose resolver records every approval request. */
  function escapeSupport(options: { unsandboxedCommands?: boolean }) {
    const asked: string[] = [];
    const built = buildCodingToolSupport({
      root,
      declared: ["Read", "Bash"],
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Bash", patterns: ["*"] },
      ],
      askRules: [{ tool: "Bash", patterns: ["*"] }],
      bashApproval: "gated",
      askResolver: {
        resolve: async (request) => {
          asked.push(request.tool);
          return { decision: "deny", decidedBy: "human", latencyMs: 3 };
        },
      },
      ...options,
    });
    if (built === undefined) throw new Error("expected the support to build");
    return { runtime: built.runtime, asked };
  }

  const escapeRequest = { command: "echo hi", unsandboxed: true };

  test("AC-15: unsandboxedCommands makes the runtime raise an approval request", async () => {
    const { runtime, asked } = escapeSupport({ unsandboxedCommands: true });
    const outcome = await runtime.callTool("Bash", escapeRequest);
    expect(asked).toEqual(["Bash"]);
    expect(outcome.kind).toBe("denied");
  });

  test("AC-15 boundary: without the option the runtime refuses the escape request", async () => {
    const { runtime, asked } = escapeSupport({});
    const outcome = await runtime.callTool("Bash", escapeRequest);
    expect(asked).toEqual([]);
    expect(outcome).toEqual({ kind: "error", content: NOT_ENABLED });
  });
});
