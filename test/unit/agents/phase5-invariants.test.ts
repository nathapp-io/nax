import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../../../");

function src(rel: string) {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Phase 5 invariants — execution stage", () => {
  test("execution.ts does not import from agent-swap.ts", () => {
    const code = src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("escalation/agent-swap");
  });

  test("execution.ts does not contain shouldAttemptSwap call", () => {
    const code = src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("shouldAttemptSwap");
  });

  test("execution.ts does not contain resolveSwapTarget call", () => {
    const code = src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("resolveSwapTarget");
  });

  test("execution.ts does not contain the Phase 5.5 comment", () => {
    const code = src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("Phase 5.5");
  });

  test("execution.ts does not contain context.v2.fallback shim", () => {
    const code = src("src/pipeline/stages/execution.ts");
    expect(code).not.toContain("context?.v2?.fallback");
  });

  test("agent-swap.ts does not exist", () => {
    expect(() => src("src/execution/escalation/agent-swap.ts")).toThrow();
  });

  test("config schema does not have context.v2.fallback field", () => {
    const code = src("src/config/schemas.ts");
    expect(code).not.toContain("ContextV2FallbackConfigSchema");
  });
});
