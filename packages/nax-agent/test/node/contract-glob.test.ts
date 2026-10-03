import { GLOB_CASES } from "@nathapp/nax-test-kit/cases/glob-cases";
import { test } from "vitest";
import { nodeRuntime } from "#src/runtime/index";

for (const c of GLOB_CASES) {
  test(c.name, () => c.run(nodeRuntime), 15_000);
}
