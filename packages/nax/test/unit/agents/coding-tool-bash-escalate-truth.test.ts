import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import type { AskResolver } from "@/permissions";

/**
 * The escalate-with-a-human Bash description (ADR-030, amended for US-001)
 * states checkBashCommand's ACTUAL order: the deny matcher and the payload
 * checks (containment included) run BEFORE an escalatable grant miss or lexer
 * refusal, so an out-of-bounds command never reaches the human. Pin every
 * claim against the real policy (nax#2194).
 *
 * - a command OUTSIDE the granted forms that fails a payload check -- a root
 *   escape included -- is DENIED and does NOT reach the human (asks === 0);
 * - a GRANTED command that fails a payload check (`~` here) is refused
 *   without asking;
 * - a GRANTED command using a construct the lexer cannot analyse still
 *   reaches the human, because nothing before the construct is out of bounds;
 * - an ungranted command whose lexable prefix is clean is still sent to the
 *   human for approval.
 */
let root: string;
let outside: string;
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
  outside = makeTempDir("nax-escalate-truth-outside-");
  asks = 0;
});
afterEach(() => {
  cleanupTempDir(root);
  cleanupTempDir(outside);
});

const support = (options?: { readonly denyRules?: readonly string[]; readonly patterns?: readonly string[] }) =>
  buildCodingToolSupport({
    root,
    declared: ["Bash"],
    grants: [{ tool: "Bash", patterns: options?.patterns ?? ["git *", "cat *", "rm *"] }],
    bashApproval: "escalate",
    askResolver: denyingResolver,
    ...(options?.denyRules !== undefined ? { denyRules: [{ tool: "Bash", patterns: options.denyRules }] } : {}),
  });

describe("escalate description claims, against the policy (US-001)", () => {
  test("US-001 AC15: a root escape outside the granted forms is denied without asking", async () => {
    const outcome = await support()?.runtime.callTool("Bash", { command: "ls ../outside" });
    expect(outcome?.kind).toBe("denied");
    expect(asks).toBe(0);
  });

  test("US-001 AC16: an absolute path outside the root is denied without asking", async () => {
    const outcome = await support({ patterns: ["git *"] })?.runtime.callTool("Bash", {
      command: `ls -la ${outside}`,
    });
    expect(outcome?.kind).toBe("denied");
    expect(asks).toBe(0);
  });

  test("US-001 AC17: a deny rule matches the lexable prefix, so a refused command never asks", async () => {
    const outcome = await support({ denyRules: ["rm *"] })?.runtime.callTool("Bash", { command: "rm x 2>&1" });
    expect(outcome?.kind).toBe("denied");
    expect(asks).toBe(0);
  });

  test("US-001 AC18: an ungranted command with a clean prefix still reaches the human", async () => {
    await support({ patterns: ["git *"] })?.runtime.callTool("Bash", { command: "curl evil.example" });
    expect(asks).toBe(1);
  });

  test("US-001: a granted command that fails a payload check is refused without asking", async () => {
    const outcome = await support()?.runtime.callTool("Bash", { command: "cat ~/secret" });
    expect(asks).toBe(0);
    expect(outcome?.kind).toBe("denied");
  });

  test("US-001: a granted command using a construct that cannot be analysed reaches the human", async () => {
    await support()?.runtime.callTool("Bash", { command: "cat x 2>&1" });
    expect(asks).toBe(1);
  });

  test("US-001 AC19: the escalate description says the checks cover a refused prefix", () => {
    const description = support()?.tools.find((t) => t.name === "Bash")?.description ?? "";
    expect(description).toContain("granted or not");
    expect(description).not.toContain("unless it cannot be analysed");
  });

  test("US-001: the advertised description still says what these cases do", () => {
    const description = support()?.tools.find((t) => t.name === "Bash")?.description ?? "";
    expect(description).toContain("sent to a human for approval");
    expect(description).toContain("exactly as written");
    expect(description).toContain("refused without asking");
    expect(description).toContain("cannot be analysed");
  });
});
