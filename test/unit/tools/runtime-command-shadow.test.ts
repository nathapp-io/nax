import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, IDENTIFIER_KEYS, makeCommandShadowRecorder, makeTempDir, observedOnly } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";

/** The tool-audit calls the runtime sink flushed to `dir`. */
function auditCalls(dir: string): Record<string, unknown>[] {
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const parsed: { calls: Record<string, unknown>[] } = JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8"));
  return parsed.calls;
}

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

describe("runtime.callTool — command shadow tap", () => {
  test("raw Bash: observed as allow, settled ok, same key", async () => {
    const r = makeCommandShadowRecorder();
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
    const r = makeCommandShadowRecorder();
    const support = session({ bashApproval: "gated", commandShadow: r.shadow });
    const outcome = await support?.runtime.callTool("Bash", { command: "rm -rf src" });
    expect(outcome?.kind).toBe("denied");
    expect(r.observed[0]?.[1].mechanical.verdict).toBe("deny");
    expect(r.settled[0]?.[1]).toEqual({ ledger: "denied" });
  });

  test("an ask the human refuses: settled denied:ask with decidedBy", async () => {
    const r = makeCommandShadowRecorder();
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

  test("US-001 AC6: the recording shadow observes the identifiers from the runtime options and context", async () => {
    const r = makeCommandShadowRecorder();
    const support = session({ bashApproval: "raw", commandShadow: r.shadow, callId: "c1", scopeId: "s1" });
    await support?.runtime.callTool("Bash", { command: "echo hi" }, { turnId: "t1", roundTrips: 3, toolCallId: "tc1" });
    expect(observedOnly(r)).toMatchObject({
      callId: "c1",
      scopeId: "s1",
      turnId: "t1",
      roundTrips: 3,
      toolCallId: "tc1",
    });
  });

  test("US-001 AC7: the tool-audit record carries the same callId, turnId and toolCallId as its Observation", async () => {
    const r = makeCommandShadowRecorder();
    const auditDir = join(root, "audit");
    const support = session({
      bashApproval: "raw",
      commandShadow: r.shadow,
      callId: "c1",
      scopeId: "s1",
      auditDir,
      sessionName: "shadow-ident",
    });
    await support?.runtime.callTool("Bash", { command: "echo hi" }, { turnId: "t1", roundTrips: 3, toolCallId: "tc1" });
    await support?.auditSink.flush();
    const record = auditCalls(auditDir)[0];
    const observed = observedOnly(r);
    expect(record?.callId).toBe(observed.callId);
    expect(record?.turnId).toBe(observed.turnId);
    expect(record?.toolCallId).toBe(observed.toolCallId);
    expect(record).toMatchObject({ callId: "c1", turnId: "t1", toolCallId: "tc1" });
  });

  test("US-001 AC8: no callId/scopeId options and no context leaves the Observation without any identifier key", async () => {
    const r = makeCommandShadowRecorder();
    const support = session({ bashApproval: "raw", commandShadow: r.shadow });
    await support?.runtime.callTool("Bash", { command: "echo hi" });
    const observed = observedOnly(r);
    for (const key of IDENTIFIER_KEYS) expect(key in observed).toBe(false);
  });

  test("a non-command tool is never observed", async () => {
    writeFileSync(join(root, "a.txt"), "x");
    const r = makeCommandShadowRecorder();
    const support = session({ commandShadow: r.shadow });
    await support?.runtime.callTool("Read", { path: "a.txt" });
    expect(r.observed).toHaveLength(0);
  });

  test("deferred audit: settle happens only when finalizeAudit runs (Review Focus 1)", async () => {
    const r = makeCommandShadowRecorder();
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
    const boom = makeCommandShadowRecorder({
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
