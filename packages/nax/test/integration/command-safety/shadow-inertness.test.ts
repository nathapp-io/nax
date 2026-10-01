/**
 * Spec §2 criterion 1 / §9: whatever the classifier does, the call's outcome,
 * its executed effect, its model-facing content AND its tool-audit row are
 * identical to a run without the shadow, and callTool never waits for the
 * classifier. Driven through buildCodingToolSupport -> runtime.callTool against
 * a real temp root and a real loopback stub server.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, type StubMode, startSystemOneStub } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import {
  _systemOneClientDeps,
  type CommandSafetyRow,
  createCommandShadow,
  createSystemOneClient,
} from "@/command-safety";

const COMMAND = "echo same > same.txt && echo shown";

let cleanups: (() => void)[];
let origClient: typeof _systemOneClientDeps;
let controller: AbortController;
beforeEach(() => {
  cleanups = [];
  origClient = { ..._systemOneClientDeps };
  // The client's timeout is driven by hand, so `hang` never waits on a clock.
  controller = new AbortController();
  _systemOneClientDeps.timeoutSignal = () => controller.signal;
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  Object.assign(_systemOneClientDeps, origClient);
});

/** The audit rows the run flushed, minus the wall-clock field. */
function auditRows(auditDir: string): unknown[] {
  const files = readdirSync(auditDir);
  expect(files).toHaveLength(1);
  const parsed: { calls: Record<string, unknown>[] } = JSON.parse(readFileSync(join(auditDir, files[0] ?? ""), "utf8"));
  return parsed.calls.map(({ at: _at, ...rest }) => rest);
}

/** One call of COMMAND in a FRESH root, so every run's paths and effects are comparable. */
async function runOnce(mode: StubMode | "off", command = COMMAND) {
  const root = realpathSync(makeTempDir("shadow-inert-"));
  const auditDir = makeTempDir("shadow-inert-audit-");
  cleanups.push(
    () => cleanupTempDir(root),
    () => cleanupTempDir(auditDir),
  );
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  const rows: CommandSafetyRow[] = [];
  let shadow: ReturnType<typeof createCommandShadow> | undefined;
  if (mode !== "off") {
    const stub = startSystemOneStub(mode);
    cleanups.push(stub.stop);
    shadow = createCommandShadow({
      classify: createSystemOneClient({ url: stub.url, timeoutMs: 3000 }),
      write: async (r) => void rows.push(r),
      runId: "run-1",
      timeoutMs: 3000,
    });
  }
  const support = buildCodingToolSupport({
    root,
    declared: ["Read", "Bash"],
    grants: [{ tool: "Read", patterns: ["*"] }],
    bashApproval: "raw",
    auditDir,
    sessionName: "inert",
    ...(shadow !== undefined ? { commandShadow: shadow } : {}),
  });
  const outcome = await support?.runtime.callTool("Bash", { command });
  await support?.auditSink.flush();
  return { outcome, rows, shadow, root, auditDir };
}

describe("shadow inertness", () => {
  test.each(["answer", "reject", "malformed", "unauthorized", "blocked", "hang"] as const)(
    "mode %s: outcome, content, effect and audit row equal the no-shadow run; exactly one shadow row",
    async (mode) => {
      const base = await runOnce("off");
      const shadowed = await runOnce(mode);
      expect(shadowed.outcome).toEqual(base.outcome);
      expect(readFileSync(join(shadowed.root, "same.txt"), "utf8")).toBe("same\n");
      expect(auditRows(shadowed.auditDir)).toEqual(auditRows(base.auditDir));
      // `hang`: callTool returned above while the classifier was still pending,
      // so no shadow row can exist yet -- the proof of no awaited latency.
      if (mode === "hang") {
        expect(shadowed.rows).toHaveLength(0);
        controller.abort(new DOMException("timed out", "TimeoutError"));
      }
      await shadowed.shadow?.drain();
      expect(shadowed.rows).toHaveLength(1);
      expect(shadowed.rows[0]?.outcome.ledger).toBe("ok");
      if (mode === "hang") expect(shadowed.rows[0]?.model).toMatchObject({ status: "unavailable", error: "timeout" });
    },
  );

  test("an oversize command runs normally and records oversize (Review Focus 2)", async () => {
    const long = `echo ${"x".repeat(20_000)} > long.txt`;
    const run = await runOnce({ oversizeAbove: 10_000 }, long);
    expect(run.outcome?.kind).toBe("ok");
    await run.shadow?.drain();
    expect(run.rows[0]?.model.status).toBe("oversize");
    expect(run.rows[0]?.command).toBe(long);
  });
});
