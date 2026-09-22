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

  // F1: the same zero-grant shape as `session()` in the deny suite, but
  // reached through the production entry point -- `scoped` with no stage
  // allow rules is the only path to `resolvePermissions` returning
  // `toolGrants: []`, and that shape must still get raw Bash.
  test("F1: a scoped config with no stage allow rules still admits raw Bash through resolveCodingToolSupport", async () => {
    const execution: Record<string, unknown> = {
      bashApproval: "raw",
      permissionProfile: "scoped",
      permissions: { run: {} },
    };
    const support = await resolveCodingToolSupport({
      declaredTools: ["Bash"],
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution }),
    });
    expect(support).toBeDefined();
    const outcome = await support?.runtime.callTool("Bash", { command: "echo $(whoami)" });
    expect(outcome?.kind).toBe("ok");
  });

  // F3: the description advertised through the SAME production entry point
  // must match what the mode actually does -- this is what a real dispatch
  // sends to the model, not just what a direct `createBashTool` call can be
  // made to say.
  test("F3: the raw description advertised through the production entry states the truth", async () => {
    const support = await supportWithMode("raw");
    const tool = support?.tools.find((t) => t.name === "Bash");
    expect(tool?.description).not.toContain("no command forms are granted");
    expect(tool?.description).not.toContain("cannot be analysed");
    expect(tool?.description).toContain("raw mode");
  });

  test("F3: the gated description advertised through the production entry is unchanged", async () => {
    const support = await supportWithMode("gated");
    const tool = support?.tools.find((t) => t.name === "Bash");
    expect(tool?.description).toContain("granted command forms: echo *");
    expect(tool?.description).toContain("cannot be analysed");
  });
});
