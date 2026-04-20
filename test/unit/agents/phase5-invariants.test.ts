import { describe, expect, test } from "bun:test";
import { join } from "path";

const ROOT = join(import.meta.dir, "../../../");

async function src(rel: string) {
  return Bun.file(join(ROOT, rel)).text();
}

describe("Phase 5 invariants — execution stage", () => {
  test("execution.ts does not import from agent-swap.ts", async () => {
    const code = await src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("escalation/agent-swap");
  });

  test("execution.ts does not contain shouldAttemptSwap call", async () => {
    const code = await src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("shouldAttemptSwap");
  });

  test("execution.ts does not contain resolveSwapTarget call", async () => {
    const code = await src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("resolveSwapTarget");
  });

  test("execution.ts does not contain the Phase 5.5 comment", async () => {
    const code = await src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("Phase 5.5");
  });

  test("execution.ts does not contain context.v2.fallback shim", async () => {
    const code = await src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("context?.v2?.fallback");
  });

  test("agent-swap.ts does not exist", async () => {
    await expect(src("src/execution/escalation/agent-swap.ts")).rejects.toThrow();
  });

  test("config schema does not have context.v2.fallback field", async () => {
    const code = await src("src/config/schemas.ts");
    expect(code).not.toContain("ContextV2FallbackConfigSchema");
  });
});
