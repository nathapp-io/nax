/** The registry on real Node (the runtime the package ships to). */
import { expect, test } from "vitest";
import { ACP_AGENT_NAMES, registryEntry } from "#src/client/registry";

test("the contract suite runs on Node, not Bun", () => {
  expect(process.versions.bun).toBeUndefined();
});

test("the registry loads and answers on Node", () => {
  expect(ACP_AGENT_NAMES).toHaveLength(5);
  expect(registryEntry("claude")?.preApproval).toBe("claudeCode.allowedTools");
});
