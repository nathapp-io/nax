/**
 * The runner-neutral spawn behaviour cases (S2 spec §4.3) against the Node
 * runtime, on real Node. The bun suite covers the same cases; this suite
 * proves the runtime the package ships to.
 */
import { SPAWN_CASES } from "@nathapp/nax-test-kit/cases/spawn-cases";
import { expect, test } from "vitest";
import { nodeRuntime } from "#src/runtime/index";

test("the contract suite runs on Node, not Bun", () => {
  expect(process.versions.bun).toBeUndefined();
});

for (const c of SPAWN_CASES) {
  test(c.name, () => c.run(nodeRuntime), 15_000);
}
