import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import { buildDispatchAskWiring } from "@/interaction";
import { type AskRequest, approvalsPath, readApprovalsFile } from "@/permissions";

const LONG = `echo ${"x".repeat(400)}`;

function capturingResolver(sink: AskRequest[]) {
  return {
    resolve: (req: AskRequest) => {
      sink.push(req);
      return Promise.resolve({ decision: "deny" as const, decidedBy: "human" as const, latencyMs: 0 });
    },
  };
}

describe("AskRequest payload", () => {
  test("carries the command VERBATIM, not the 200-char summary", async () => {
    // `compileToolPolicy` realpaths the root (macOS /var -> /private/var), so
    // the test must compare like with like; on Linux realpath is a no-op.
    const root = realpathSync(makeTempDir("ask-payload-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]\n");
    const seen: AskRequest[] = [];
    const support = buildCodingToolSupport({
      root,
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["echo *"] }],
      askRules: [{ tool: "Bash", patterns: ["echo *"] }],
      bashApproval: "gated",
      askResolver: capturingResolver(seen),
    });
    await support?.runtime.callTool("Bash", { command: LONG });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe(LONG);
    expect(seen[0]?.command?.length).toBeGreaterThan(200);
    expect(seen[0]?.root).toBe(root);
    cleanupTempDir(root);
  });

  // #2249: the remembered-approval entry derives its `origin` and `matchedRule` from this field.
  function gitRoot(): string {
    const root = realpathSync(makeTempDir("ask-payload-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]\n");
    return root;
  }

  test("#2249: an ask-rule verdict carries the matched rule as matchedRule", async () => {
    const root = gitRoot();
    try {
      const seen: AskRequest[] = [];
      const support = buildCodingToolSupport({
        root,
        declared: ["Bash"],
        grants: [{ tool: "Bash", patterns: ["echo *"] }],
        askRules: [{ tool: "Bash", patterns: ["echo *"] }],
        bashApproval: "gated",
        askResolver: capturingResolver(seen),
      });
      await support?.runtime.callTool("Bash", { command: "echo hi" });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.matchedRule).toBe("Bash(echo *)");
    } finally {
      cleanupTempDir(root);
    }
  });

  test("#2249: an escalated grant miss carries no matchedRule", async () => {
    const root = gitRoot();
    try {
      const seen: AskRequest[] = [];
      const support = buildCodingToolSupport({
        root,
        declared: ["Bash"],
        grants: [{ tool: "Bash", patterns: ["ls *"] }],
        bashApproval: "escalate",
        askResolver: capturingResolver(seen),
      });
      await support?.runtime.callTool("Bash", { command: "echo hi" });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.matchedRule).toBeUndefined();
    } finally {
      cleanupTempDir(root);
    }
  });

  test("#2249: an ask-rule Bash call remembered via the dispatch wiring writes origin askRule and the rule", async () => {
    const root = gitRoot();
    const outputDir = makeTempDir("ask-payload-out-");
    try {
      const wiring = await buildDispatchAskWiring({
        config: makeNaxConfig({ interaction: { plugin: "cli" } }),
        interaction: {
          prompt: (request) =>
            Promise.resolve({ requestId: request.id, action: "allow-remember", respondedAt: Date.now() }),
          cancel: () => Promise.resolve(),
        },
        outputDir,
        runId: "run-1",
        repoRoot: root,
        projectRoot: root,
        featureName: "feat",
        stageModes: ["gated"],
      });
      const support = buildCodingToolSupport({
        root,
        declared: ["Bash"],
        grants: [{ tool: "Bash", patterns: ["echo *"] }],
        askRules: [{ tool: "Bash", patterns: ["echo *"] }],
        bashApproval: "gated",
        askResolver: wiring.askResolver,
      });
      await support?.runtime.callTool("Bash", { command: "echo hi" });
      await wiring.dispose();
      const { entries } = await readApprovalsFile(approvalsPath(outputDir));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        command: "echo hi",
        origin: "askRule",
        matchedRule: "Bash(echo *)",
        approvedBy: "cli",
      });
    } finally {
      cleanupTempDir(root);
      cleanupTempDir(outputDir);
    }
  });
});
