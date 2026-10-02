/**
 * Characterisation tests for `resolveCodingToolSupport` branches nothing else
 * pins, written (green against the unrefactored function) before the A7
 * cognitive-complexity drain moves the function's decision tree into
 * extracted helpers. Each test names the branch it pins; if one fails after a
 * refactor, the refactor changed behaviour, not style.
 *
 * Covered elsewhere (NOT re-pinned here): the provider gate profiles
 * (coding-tool-support-scratchpad.test.ts), Mcp-rule admission under scoped
 * (mcp-under-scoped.test.ts), per-package config resolution and its failure
 * fallback (coding-tool-support.test.ts), ledger location/header, TMPDIR,
 * bashApproval threading, sandbox-wrapped screen.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ToolProvider } from "@nathapp/nax-agent";
import { _resetSandboxRegistryForTests } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";

afterEach(() => _resetSandboxRegistryForTests());

function failingProvider(id: string): ToolProvider {
  return {
    id,
    kind: "static",
    stages: ["run"],
    tools: async () => {
      throw new Error("provider exploded");
    },
  };
}

describe("resolveCodingToolSupport — characterised dispatch edges (pre-A7)", () => {
  test("a provider-only op whose only provider fails logs the drop and yields no support", async () => {
    resetLogger();
    const logCalls: LogEntry[] = [];
    initLogger({ level: "silent" });
    const removeSink = addSink((entry) => logCalls.push(entry));
    const root = makeTempDir("nax-cts-provider-fail-");
    try {
      // R15 makes a provider-only op real by appending the provider's tool
      // names; a provider that throws contributes none, so the union stays
      // empty and the empty-union guard returns undefined — AFTER the drop is
      // logged (the "must not vanish silently" rule, nax#2066's sibling).
      const support = await resolveCodingToolSupport({
        declaredTools: [],
        providers: [failingProvider("doomed")],
        codingToolRoot: root,
        pipelineStage: "run",
        config: makeNaxConfig(),
      });

      expect(support).toBeUndefined();
      const dropped = logCalls.find((entry) => entry.message.includes("[provider] dropped"));
      expect(dropped).toBeDefined();
      expect(dropped?.level).toBe("warn");
      expect(dropped?.stage).toBe("tools");
      expect(dropped?.data?.providerId).toBe("doomed");
      expect(String(dropped?.data?.reason)).toContain("provider exploded");
    } finally {
      removeSink();
      resetLogger();
      cleanupTempDir(root);
    }
  });

  test("an op that declares no tools and has no providers gets no support at all", async () => {
    const root = makeTempDir("nax-cts-noop-hop-");
    try {
      // The universal-tool append only fires when the op declared names OR a
      // provider contributed names; with neither, the union is empty and the
      // hop is a no-op (returning undefined rather than building a runtime
      // that would force CODING_TOOL_ROOT_MISSING on a rootless caller).
      const support = await resolveCodingToolSupport({
        declaredTools: [],
        codingToolRoot: root,
        pipelineStage: "run",
        config: makeNaxConfig(),
      });

      expect(support).toBeUndefined();
    } finally {
      cleanupTempDir(root);
    }
  });

  test("a runtime config whose stripEnvVars is not an array strips nothing", async () => {
    const secretName = "NAX_CTS_EDGE_SECRET";
    const previous = process.env[secretName];
    process.env[secretName] = "must-not-be-stripped";
    try {
      // RULING F2: options.config is typed as the agent-manager Pick, but both
      // hops source it from the full NaxConfig at runtime — the type lies, so
      // the junk shape below is reachable. The Array.isArray guard must fall
      // back to [] (no stripping), not throw.
      const config = Object.assign(makeNaxConfig(), {
        quality: {
          commands: { leak: `printf '%s' "$${secretName}"` },
          stripEnvVars: secretName,
        },
      });
      const support = await resolveCodingToolSupport({
        declaredTools: ["RunCommand"],
        codingToolRoot: process.cwd(),
        pipelineStage: "run",
        config,
      });
      const result = await support?.runtime.callTool("RunCommand", { command: "leak" });
      expect(result?.kind).toBe("ok");
      if (result?.kind !== "ok") throw new Error("expected RunCommand to succeed");
      expect(result.content).toContain("must-not-be-stripped");
    } finally {
      if (previous === undefined) delete process.env[secretName];
      else process.env[secretName] = previous;
    }
  });

  test("a command entry whose value is neither string nor array is dropped from the declared-command map", async () => {
    resetLogger();
    const logCalls: LogEntry[] = [];
    initLogger({ level: "silent" });
    const removeSink = addSink((entry) => logCalls.push(entry));
    const root = makeTempDir("nax-cts-junk-command-");
    try {
      // The declared-command map filters Object.entries(commands) to
      // string | array values (the QualityCommandSpec shapes); junk reachable
      // only through the F2 runtime lie must be dropped, not crash the map.
      const config = Object.assign(makeNaxConfig(), {
        quality: { commands: { real: "echo REAL", junk: 42 } },
      });
      await resolveCodingToolSupport({
        declaredTools: ["RunCommand"],
        codingToolRoot: root,
        pipelineStage: "run",
        storyId: "US-EDGE",
        config,
      });

      const entry = logCalls.find((l) => l.message.includes("Declared commands resolved"));
      expect(entry).toBeDefined();
      expect(entry?.data?.commands).toEqual(["real"]);
    } finally {
      removeSink();
      resetLogger();
      cleanupTempDir(root);
    }
  });
});
