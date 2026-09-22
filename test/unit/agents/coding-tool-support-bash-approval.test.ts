import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support";

/**
 * The bashApproval seam: resolvePermissions resolves the mode and
 * resolveCodingToolSupport threads it into buildCodingToolSupport. Nothing
 * else exercises that thread — the deny suite passes the mode explicitly and
 * the config tests stop at resolvePermissions — so deleting the forwarding
 * line compiles and silently reverts every real hop to gated. These two calls
 * differ ONLY in config.execution.bashApproval; a dropped thread fails here.
 */
describe("resolveCodingToolSupport — bashApproval threading", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("nax-cts-bash-approval-");
  });

  afterEach(() => {
    cleanupTempDir(root);
  });

  const supportWithMode = (bashApproval: "gated" | "raw") => {
    // `permissions.run.allow` is in the zod schema but not in the narrow
    // runtime-types alias, so the execution block is widened at the boundary.
    const execution: Record<string, unknown> = {
      bashApproval,
      permissions: { run: { allow: ["Bash(echo *)"] } },
    };
    return resolveCodingToolSupport({
      declaredTools: ["Bash"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution }),
    });
  };

  test("a gated config refuses command substitution through the production entry", async () => {
    const support = await supportWithMode("gated");
    const outcome = await support?.runtime.callTool("Bash", { command: "echo $(whoami)" });
    expect(outcome?.kind).toBe("denied");
    if (outcome?.kind === "denied") expect(outcome.reason).toContain("cannot be analysed");
  });

  test("a raw config admits the same command through the production entry", async () => {
    const support = await supportWithMode("raw");
    const outcome = await support?.runtime.callTool("Bash", { command: "echo $(whoami)" });
    expect(outcome?.kind).toBe("ok");
  });
});
