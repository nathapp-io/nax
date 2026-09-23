import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import type { AskResolver } from "@/permissions";

/**
 * The escalate-with-a-human Bash description (ADR-030, amended 2026-09-23)
 * makes two claims about the ask tier. Pin both against the real policy, so
 * the text cannot drift from checkBashCommand's evaluation order again:
 *
 * - a command OUTSIDE the granted forms reaches the human -- even one that
 *   would escape the root, because the grant miss returns before the payload
 *   checks (nax#2194; when that is fixed, this test flips with the text);
 * - a GRANTED command that fails a payload check (`~` here) is refused
 *   without asking.
 */
let root: string;
let asks: number;
const denyingResolver: AskResolver = {
  humanReachable: true,
  resolve: async () => {
    asks += 1;
    return { decision: "deny", decidedBy: "human", latencyMs: 0 };
  },
};

beforeEach(() => {
  root = makeTempDir("nax-escalate-truth-");
  asks = 0;
});
afterEach(() => cleanupTempDir(root));

const support = (denyRules?: readonly string[]) =>
  buildCodingToolSupport({
    root,
    declared: ["Bash"],
    grants: [{ tool: "Bash", patterns: ["git *", "cat *", "rm *"] }],
    bashApproval: "escalate",
    askResolver: denyingResolver,
    ...(denyRules !== undefined ? { denyRules: [{ tool: "Bash", patterns: denyRules }] } : {}),
  });

describe("escalate description claims, against the policy", () => {
  test("a command outside the granted forms reaches the human, even a root escape (nax#2194)", async () => {
    const outcome = await support()?.runtime.callTool("Bash", { command: "ls ../outside" });
    expect(asks).toBe(1);
    expect(outcome?.kind).toBe("denied");
  });

  test("a granted command that fails a payload check is refused without asking", async () => {
    const outcome = await support()?.runtime.callTool("Bash", { command: "cat ~/secret" });
    expect(asks).toBe(0);
    expect(outcome?.kind).toBe("denied");
  });

  test("a granted command using a construct that cannot be analysed reaches the human", async () => {
    await support()?.runtime.callTool("Bash", { command: "cat x 2>&1" });
    expect(asks).toBe(1);
  });

  test("a deny rule refuses without asking, unless the command cannot be analysed (nax#2194)", async () => {
    await support(["rm *"])?.runtime.callTool("Bash", { command: "rm x" });
    expect(asks).toBe(0);
    await support(["rm *"])?.runtime.callTool("Bash", { command: "rm x 2>&1" });
    expect(asks).toBe(1);
  });

  test("the advertised description says what these cases do", () => {
    const description = support()?.tools.find((t) => t.name === "Bash")?.description ?? "";
    expect(description).toContain("sent to a human for approval");
    expect(description).toContain("exactly as written");
    expect(description).toContain("refused without asking");
  });
});
