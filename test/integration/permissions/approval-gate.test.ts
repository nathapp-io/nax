import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import { chainAskLinks } from "@/permissions";

function repo() {
  const root = makeTempDir("approval-gate-");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  return root;
}

const allowLink = { name: "t", resolve: async () => ({ decision: "allow" as const, decidedBy: "human" as const }) };
const denyLink = { name: "t", resolve: async () => ({ decision: "deny" as const, decidedBy: "human" as const }) };

function session(root: string, links: Parameters<typeof chainAskLinks>[0]) {
  return buildCodingToolSupport({
    root,
    declared: ["Bash"],
    grants: [{ tool: "Bash", patterns: ["echo *"] }],
    bashApproval: "escalate",
    askResolver: chainAskLinks(links),
  });
}

describe("approval gate, end to end", () => {
  test("escalate + an allowing resolver EXECUTES the command", async () => {
    const root = repo();
    const marker = join(root, "SHOULD-EXIST");
    const outcome = await session(root, [allowLink])?.runtime.callTool("Bash", {
      command: `echo hi && touch ${marker}`,
    });
    expect(outcome?.kind).toBe("ok");
    // Assert the EXECUTED outcome, not just the verdict: an allow that never
    // reaches the shell satisfies a kind-only assertion.
    expect(existsSync(marker)).toBe(true);
    cleanupTempDir(root);
  });

  test("escalate + a denying resolver refuses and spawns nothing", async () => {
    const root = repo();
    const marker = join(root, "SHOULD-NOT-EXIST");
    const outcome = await session(root, [denyLink])?.runtime.callTool("Bash", {
      command: `echo hi && touch ${marker}`,
    });
    expect(outcome?.kind).toBe("denied");
    // Assert the EXECUTED outcome, not just the verdict: a gate that denies
    // while the side effect still lands satisfies a kind-only assertion.
    expect(existsSync(marker)).toBe(false);
    cleanupTempDir(root);
  });

  // SPEC CASE 10. The file lives under outputDir, outside repoRoot, so the
  // TYPED tools cannot address it. Assert the EXECUTED outcome -- whether the
  // file actually changed -- not the verdict alone.
  test("the approvals file is unreachable to the typed tools, reads included", async () => {
    const root = repo();
    const outside = makeTempDir("approvals-out-");
    const file = join(outside, "approvals.json");
    writeFileSync(file, '{"entries":[]}');

    const support = buildCodingToolSupport({
      root,
      declared: ["Read", "Write", "Delete"],
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Write", patterns: ["*"] },
        { tool: "Delete", patterns: ["*"] },
      ],
      bashApproval: "gated",
    });

    for (const [tool, input] of [
      ["Read", { path: file }],
      ["Write", { path: file, content: "forged" }],
      ["Delete", { path: file }],
    ] as const) {
      const outcome = await support?.runtime.callTool(tool, input);
      expect(outcome?.kind).toBe("denied");
    }
    expect(readFileSync(file, "utf8")).toBe('{"entries":[]}');
    cleanupTempDir(root);
    cleanupTempDir(outside);
  });

  test("an empty chain denies: no channel means no approval", async () => {
    const root = repo();
    const marker = join(root, "SHOULD-NOT-EXIST");
    // The same escalating command as the deny case: `echo hi && echo there`
    // matches the `echo *` grant mechanically, so the chain is never consulted
    // and the test would pass (or fail) for the wrong reason.
    const outcome = await session(root, [])?.runtime.callTool("Bash", {
      command: `echo hi && touch ${marker}`,
    });
    expect(outcome?.kind).toBe("denied");
    expect(existsSync(marker)).toBe(false);
    cleanupTempDir(root);
  });
});
