import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC_ROOT = join(import.meta.dir, "../../../src");

async function readSrc(relPath: string): Promise<string> {
  return Bun.file(join(SRC_ROOT, relPath)).text();
}

describe("run-level SessionManager wiring", () => {
  test("runner-execution forwards options.sessionManager into executeUnified context", async () => {
    const src = await readSrc("execution/runner-execution.ts");
    expect(src).toContain("sessionManager: options.sessionManager ?? new SessionManager()");
  });

  test("iteration-runner uses ctx.sessionManager instead of creating a new SessionManager", async () => {
    const src = await readSrc("execution/iteration-runner.ts");
    expect(src).toContain("sessionManager: ctx.sessionManager");
    expect(src).not.toContain("new SessionManager()");
  });

  test("iteration-runner does not reset the shared AgentManager before story execution", async () => {
    const src = await readSrc("execution/iteration-runner.ts");
    expect(src).not.toContain("agentManager?.reset()");
  });

  test("run-setup creates and returns a run-level sessionManager", async () => {
    const src = await readSrc("execution/lifecycle/run-setup.ts");
    expect(src).toContain("const sessionManager = new SessionManager()");
    expect(src).toContain("sessionManager,");
  });
});
