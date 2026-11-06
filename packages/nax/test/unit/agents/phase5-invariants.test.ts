import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../");

async function src(rel: string) {
  return Bun.file(join(ROOT, rel)).text();
}

describe("Phase 5 invariants — execution stage", () => {
  test("agent-swap.ts does not exist", async () => {
    await expect(src("src/execution/escalation/agent-swap.ts")).rejects.toThrow();
  });

  test("config schema does not have context.v2.fallback field", async () => {
    const code = await src("src/config/schemas.ts");
    expect(code).not.toContain("ContextV2FallbackConfigSchema");
  });
});
