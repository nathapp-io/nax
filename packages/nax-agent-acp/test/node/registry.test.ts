/**
 * The registry on real Node (the runtime the package ships to).
 *
 * This file's runner is vitest on Node (`vitest.config.ts` includes `test/node/**`; CI runs
 * `test:node`). Bun's own runner can also load it — the `vitest` import resolves — and the
 * scoped test selection hands it to `bun test <file>` whenever the file is in a diff, so the
 * Node verdict is registered only under vitest: `bun test` on a vitest file is a wrong-runner
 * invocation, not a broken Node contract, and reporting it as one fails a gate it can never
 * pass. The verdict is otherwise unchanged, so `test:node` still fails if vitest itself is
 * ever made to run on Bun.
 */
import { expect, test } from "vitest";
import { ACP_AGENT_NAMES, registryEntry } from "#src/client/registry";

/** Vitest's CLI sets this in its own process, inherited by every worker. */
const UNDER_VITEST_RUNNER = process.env.VITEST === "true";

if (UNDER_VITEST_RUNNER) {
  test("the contract suite runs on Node, not Bun", () => {
    expect(process.versions.bun).toBeUndefined();
  });
}

test("the registry loads and answers on Node", () => {
  expect(ACP_AGENT_NAMES).toHaveLength(6);
  expect(registryEntry("claude")?.preApproval).toBe("claudeCode.allowedTools");
});
