import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import { appendApproval, approvalsPath, chainAskLinks, createApprovalsLink } from "@/permissions";

function repo() {
  const root = makeTempDir("approval-gate-");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  return root;
}

const allowLink = { name: "t", resolve: async () => ({ decision: "allow" as const, decidedBy: "human" as const }) };
const denyLink = { name: "t", resolve: async () => ({ decision: "deny" as const, decidedBy: "human" as const }) };

function session(root: string, links: Parameters<typeof chainAskLinks>[0], pipelineStage?: string) {
  return buildCodingToolSupport({
    root,
    declared: ["Bash"],
    grants: [{ tool: "Bash", patterns: ["echo *"] }],
    bashApproval: "escalate",
    askResolver: chainAskLinks(links),
    ...(pipelineStage !== undefined ? { pipelineStage } : {}),
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
      declared: ["Read", "Write", "Edit", "Delete"],
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Write", patterns: ["*"] },
        { tool: "Edit", patterns: ["*"] },
        { tool: "Delete", patterns: ["*"] },
      ],
      bashApproval: "gated",
    });

    for (const [tool, input] of [
      ["Read", { path: file }],
      ["Write", { path: file, content: "forged" }],
      // Edit's real input fields (src/tools/edit.ts:29-37): path/old_string/new_string.
      ["Edit", { path: file, old_string: '"entries":[]', new_string: "forged" }],
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

  // SPEC CASE 7. The cached human decision resolves BEFORE the chain consults a
  // human: an exact (stage, command) hit executes and never dispatches an
  // interaction request. The file lies OUTSIDE repoRoot and every stage is
  // non-raw, or createApprovalsLink would disable itself.
  test("a cache hit allows without dispatching an interaction request", async () => {
    const root = repo();
    const outside = makeTempDir("approvals-out-");
    const approvalsFile = approvalsPath(outside);
    const marker = join(root, "SHOULD-EXIST");
    const command = `echo hi && touch ${marker}`;
    await appendApproval(approvalsFile, {
      stage: "run",
      command,
      root,
      origin: "escalate",
      matchedRule: null,
      approvedAt: "2026-09-22T10:00:00.000Z",
      approvedBy: "telegram:123",
      naxCommit: "7b37dbf74",
    });

    let consulted = 0;
    const humanSpy = {
      name: "human-spy",
      resolve: async () => {
        consulted++;
        return { decision: "allow" as const, decidedBy: "human" as const };
      },
    };

    const outcome = await session(
      root,
      [createApprovalsLink({ approvalsFile, repoRoot: root, stageModes: ["escalate"] }), humanSpy],
      "run",
    )?.runtime.callTool("Bash", { command });

    expect(outcome?.kind).toBe("ok");
    expect(existsSync(marker)).toBe(true);
    expect(consulted).toBe(0);
    cleanupTempDir(root);
    cleanupTempDir(outside);
  });
});
