import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import type { CommandShadow, FinalOutcome, Observation } from "@/command-safety";

let root: string;
beforeEach(() => {
  root = realpathSync(makeTempDir("runtime-shadow-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n");
});
afterEach(() => cleanupTempDir(root));

/** The deny suite's shape: Read declared AND granted, so a session always builds. */
const BASE = { declared: ["Read", "Bash"], grants: [{ tool: "Read", patterns: ["*"] }] } as const;
const session = (extra: Omit<Parameters<typeof buildCodingToolSupport>[0], "root" | "declared" | "grants">) =>
  buildCodingToolSupport({ root, declared: [...BASE.declared], grants: [...BASE.grants], ...extra });

function recorder(overrides: Partial<CommandShadow> = {}) {
  const observed: [string, Observation][] = [];
  const settled: [string, FinalOutcome][] = [];
  const shadow: CommandShadow = {
    observe: (k, o) => void observed.push([k, o]),
    settle: (k, o) => void settled.push([k, o]),
    drain: async () => {},
    ...overrides,
  };
  return { shadow, observed, settled };
}

describe("runtime.callTool — command shadow tap", () => {
  test("raw Bash: observed as allow, settled ok, same key", async () => {
    const r = recorder();
    const support = session({ bashApproval: "raw", commandShadow: r.shadow });
    const outcome = await support?.runtime.callTool("Bash", { command: "echo hi > out.txt" });
    expect(outcome?.kind).toBe("ok");
    expect(existsSync(join(root, "out.txt"))).toBe(true);
    expect(r.observed).toHaveLength(1);
    expect(r.observed[0]?.[1]).toMatchObject({
      command: "echo hi > out.txt",
      identity: "Bash",
      mechanical: { verdict: "allow" },
    });
    expect(r.settled).toEqual([[r.observed[0]?.[0] ?? "", { ledger: "ok" }]]);
  });

  test("gated Bash with no grant: observed as deny, settled denied", async () => {
    const r = recorder();
    const support = session({ bashApproval: "gated", commandShadow: r.shadow });
    const outcome = await support?.runtime.callTool("Bash", { command: "rm -rf src" });
    expect(outcome?.kind).toBe("denied");
    expect(r.observed[0]?.[1].mechanical.verdict).toBe("deny");
    expect(r.settled[0]?.[1]).toEqual({ ledger: "denied" });
  });

  test("an ask the human refuses: settled denied:ask with decidedBy", async () => {
    const r = recorder();
    const support = buildCodingToolSupport({
      root,
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["echo *"] }],
      askRules: [{ tool: "Bash", patterns: ["echo *"] }],
      bashApproval: "gated",
      askResolver: { resolve: async () => ({ decision: "deny", decidedBy: "human", latencyMs: 0 }) },
      commandShadow: r.shadow,
    });
    await support?.runtime.callTool("Bash", { command: "echo hi" });
    expect(r.observed[0]?.[1].mechanical).toMatchObject({ verdict: "ask", rule: expect.any(String) });
    expect(r.settled[0]?.[1]).toEqual({ ledger: "denied:ask", decidedBy: "human" });
  });

  test("a non-command tool is never observed", async () => {
    writeFileSync(join(root, "a.txt"), "x");
    const r = recorder();
    const support = session({ commandShadow: r.shadow });
    await support?.runtime.callTool("Read", { path: "a.txt" });
    expect(r.observed).toHaveLength(0);
  });

  test("deferred audit: settle happens only when finalizeAudit runs (Review Focus 1)", async () => {
    const r = recorder();
    const support = session({ bashApproval: "raw", commandShadow: r.shadow });
    const outcome = await support?.runtime.callTool(
      "Bash",
      { command: "echo deferred" },
      { deferModelTruncation: true },
    );
    expect(r.observed).toHaveLength(1);
    expect(r.settled).toHaveLength(0);
    if (outcome?.kind === "ok") outcome.finalizeAudit?.(outcome.content);
    expect(r.settled[0]?.[1]).toEqual({ ledger: "ok" });
  });

  test("a throwing shadow leaves the outcome and the executed effect unchanged", async () => {
    const boom = recorder({
      observe: () => {
        throw new Error("observe");
      },
      settle: () => {
        throw new Error("settle");
      },
    });
    const plain = session({ bashApproval: "raw" });
    const shadowed = session({ bashApproval: "raw", commandShadow: boom.shadow });
    const a = await plain?.runtime.callTool("Bash", { command: "echo one > one.txt" });
    const b = await shadowed?.runtime.callTool("Bash", { command: "echo two > two.txt" });
    expect(a?.kind).toBe("ok");
    expect(b?.kind).toBe("ok");
    expect(existsSync(join(root, "two.txt"))).toBe(true);
  });
});
