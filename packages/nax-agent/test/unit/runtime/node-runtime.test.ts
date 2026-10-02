import { describe, test } from "bun:test";
import { SPAWN_CASES } from "@nathapp/nax-test-kit/cases/spawn-cases";
import { nodeRuntime } from "#src/runtime/index";

describe("nodeRuntime meets the spawn behaviour cases", () => {
  for (const c of SPAWN_CASES) test(c.name, () => c.run(nodeRuntime), 15_000);
});
